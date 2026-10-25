import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, cancellationRequestInbox, contractCancellationRequests, contracts } from "../drizzle/schema";
import { getDb } from "./db";
import { isDuplicateKeyError, withDeadlockRetry } from "./mysqlErrors";
import { logger } from "./logger";

/**
 * M-A09-01a (decisão D3 do Lucas): o cancelamento nasce no Relationship e chega ao CRM por contrato versionado `relationship.cancellation_requested.v1`.
 * Receptor primeiro: o CRM GRAVA o pedido numa caixa de entrada e devolve um PROTOCOLO persistido (o ACK). O pedido NÃO cria distrato, NÃO aprova e NÃO libera cota:
 * quem decide é o CRM (contract_cancellation_requests, fluxo existente); a fração só volta no distrato EXECUTADO. O Relationship consulta o estado por GET.
 * DESLIGADO por padrão (RELATIONSHIP_CANCELLATION_INBOX_ENABLED): 404 mesmo com a chave certa; sem RELATIONSHIP_INBOUND_KEY também 404.
 * - 401 sem/errada chave ANTES de ler o corpo; com chave, corpo ruim = 400 INVALID_EVENT. Sem texto livre e sem dado pessoal (contrato, código de motivo, ator opaco).
 * - idempotente por eventId E por requestId: replay 200 com o MESMO protocolo; mesmo id com corpo diferente 409; contrato desconhecido 422 UNKNOWN_CONTRACT; contrato já cancelado 422 CONTRACT_ALREADY_CANCELLED.
 */
export const RELATIONSHIP_CANCELLATION_PATH = "/api/integrations/relationship/cancellation-request";

const instant = z.string().datetime().refine(value => { const ms = Date.parse(value); return ms >= Date.parse("2000-01-01T00:00:00Z") && ms <= Date.parse("2037-12-31T23:59:59Z"); }, "Horário fora da faixa aceita.");
const opaque = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);
export const CANCELLATION_REASON_CODES = ["customer_request", "rescue_failed", "payment_default", "other"] as const;
export const relationshipCancellationSchema = z.strictObject({
  eventId: opaque(120),
  requestId: opaque(120),
  contractId: z.number().int().positive(),
  reasonCode: z.enum(CANCELLATION_REASON_CODES),
  actor: z.string().trim().regex(/^[A-Za-z0-9:_.-]{1,120}$/),
  requestedAt: instant,
  source: z.literal("relationship"),
});
export type RelationshipCancellation = z.infer<typeof relationshipCancellationSchema>;

export class RelationshipCancellationRejection extends Error {
  constructor(readonly code: "UNKNOWN_CONTRACT" | "CONTRACT_ALREADY_CANCELLED" | "EVENT_ID_CONFLICT", message: string) { super(message); this.name = "RelationshipCancellationRejection"; }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
export const relationshipCancellationHash = (event: RelationshipCancellation) => createHash("sha256").update(JSON.stringify([event.eventId, event.requestId, event.contractId, event.reasonCode, event.actor, event.requestedAt, event.source])).digest("hex");

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type CancellationProtocolStatus = "received" | "under_review" | "approved" | "rejected" | "executed" | "withdrawn";
/** Estado devolvido ao Relationship: derivado do fluxo de distrato do CRM (a caixa só liga os dois). Pedido sem distrato aberto = `received`. */
export function protocolStatusOf(requestStatus: "requested" | "approved" | "rejected" | "executed" | "cancelled" | null | undefined): CancellationProtocolStatus {
  switch (requestStatus) {
    case "requested": return "under_review";
    case "approved": return "approved";
    case "rejected": return "rejected";
    case "executed": return "executed";
    case "cancelled": return "withdrawn";
    default: return "received";
  }
}

/** Grava o pedido (uma linha + trilha) na mesma transação. Idempotente por eventId e por requestId. Devolve o protocolo (ACK). */
export async function recordRelationshipCancellation(db: Db, event: RelationshipCancellation): Promise<{ replay: boolean; protocol: string }> {
  const hash = relationshipCancellationHash(event);
  const existing = async (executor: Db | Tx) => {
    const columns = { protocol: cancellationRequestInbox.protocol, payloadHash: cancellationRequestInbox.payloadHash };
    const byEvent = (await executor.select(columns).from(cancellationRequestInbox).where(eq(cancellationRequestInbox.eventId, event.eventId)).limit(1))[0];
    return byEvent ?? (await executor.select(columns).from(cancellationRequestInbox).where(eq(cancellationRequestInbox.requestId, event.requestId)).limit(1))[0];
  };
  const settle = (row: NonNullable<Awaited<ReturnType<typeof existing>>>) => {
    if (row.payloadHash !== hash) throw new RelationshipCancellationRejection("EVENT_ID_CONFLICT", "O eventId/requestId já foi usado com outro conteúdo.");
    return { replay: true, protocol: row.protocol };
  };
  const seen = await existing(db);
  if (seen) return settle(seen);
  try {
    return await withDeadlockRetry(() => db.transaction(async tx => {
      const [contract] = await tx.select({ id: contracts.id, status: contracts.status }).from(contracts).where(eq(contracts.id, event.contractId)).limit(1);
      if (!contract) throw new RelationshipCancellationRejection("UNKNOWN_CONTRACT", "Contrato desconhecido.");
      if (contract.status === "cancelled") throw new RelationshipCancellationRejection("CONTRACT_ALREADY_CANCELLED", "O contrato já está cancelado.");
      const protocol = randomUUID();
      const [{ id }] = await tx.insert(cancellationRequestInbox).values({
        protocol, eventId: event.eventId, requestId: event.requestId, payloadHash: hash, contractId: event.contractId, reasonCode: event.reasonCode, actor: event.actor, requestedAt: new Date(event.requestedAt),
      }).$returningId();
      await tx.insert(auditLogs).values({
        actorUserId: null, entityType: "contract", entityId: String(event.contractId), action: "relationship_cancellation_received",
        summary: `Pedido de cancelamento recebido do Relationship (protocolo ${protocol}, motivo ${event.reasonCode}). Nenhum distrato foi aberto.`, idempotencyKey: `audit:relationship-cancel:${event.eventId}`,
      });
      void id;
      return { replay: false, protocol };
    }));
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await existing(db);
      if (raced) return settle(raced);
    }
    throw error;
  }
}

/** Consulta do protocolo pelo Relationship: estado derivado do distrato ligado (se houver). */
export async function lookupCancellationProtocol(db: Db, protocol: string): Promise<{ protocol: string; contractId: number; status: CancellationProtocolStatus; receivedAt: string } | null> {
  const [row] = await db.select({ protocol: cancellationRequestInbox.protocol, contractId: cancellationRequestInbox.contractId, createdAt: cancellationRequestInbox.createdAt, requestStatus: contractCancellationRequests.status })
    .from(cancellationRequestInbox).leftJoin(contractCancellationRequests, eq(cancellationRequestInbox.cancellationRequestId, contractCancellationRequests.id)).where(eq(cancellationRequestInbox.protocol, protocol)).limit(1);
  if (!row) return null;
  return { protocol: row.protocol, contractId: row.contractId, status: protocolStatusOf(row.requestStatus), receivedAt: row.createdAt.toISOString() };
}

const bearer = (request: Request) => { const authorization = request.get("authorization") ?? ""; return authorization.startsWith("Bearer ") ? authorization.slice(7) : ""; };

async function handlePost(request: Request, response: Response) {
  const parsed = relationshipCancellationSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ accepted: false, code: "INVALID_EVENT", error: "Invalid event" }); return; }
  const db = await getDb();
  if (!db) { response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Database unavailable" }); return; }
  try {
    const result = await recordRelationshipCancellation(db, parsed.data);
    response.status(result.replay ? 200 : 201).json({ accepted: true, replay: result.replay, eventId: parsed.data.eventId, protocol: result.protocol });
  } catch (error) {
    if (error instanceof RelationshipCancellationRejection) {
      logger.warn("Relationship cancellation rejected by a domain rule", { code: error.code, eventId: parsed.data.eventId });
      response.status(error.code === "EVENT_ID_CONFLICT" ? 409 : 422).json({ accepted: false, code: error.code, error: error.message });
      return;
    }
    logger.error("Relationship cancellation ingest failed", { eventId: parsed.data.eventId, errorName: error instanceof Error ? error.name : "non-Error" });
    response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" });
  }
}

async function handleGet(request: Request, response: Response) {
  const protocol = String(request.params.protocol ?? "");
  if (!/^[0-9a-f-]{36}$/.test(protocol)) { response.status(404).json({ error: "Not found" }); return; }
  const db = await getDb();
  if (!db) { response.status(503).json({ code: "EVENT_PROCESSING_FAILED", error: "Database unavailable" }); return; }
  try {
    const found = await lookupCancellationProtocol(db, protocol);
    if (!found) { response.status(404).json({ error: "Not found" }); return; }
    response.status(200).json(found);
  } catch (error) {
    logger.error("Relationship cancellation lookup failed", { errorName: error instanceof Error ? error.name : "non-Error" });
    response.status(503).json({ code: "EVENT_PROCESSING_FAILED", error: "Lookup failed" });
  }
}

/** Portão ANTES do parser JSON global: 404 (flag off/sem chave), 401 sem ler o corpo, com chave corpo lido com limite de 16 KB (JSON ruim = 400). Cobre o POST e o GET do protocolo. */
export function registerRelationshipCancellationGate(app: Express, integrationKey: string | undefined, enabled: boolean) {
  const parse = express.json({ limit: "16kb" });
  const guard = (request: Request, response: Response, next: NextFunction) => {
    const key = integrationKey?.trim();
    if (!enabled || !key) { response.status(404).json({ error: "Not found" }); return; }
    const supplied = bearer(request);
    if (!supplied || !safeEqual(supplied, key)) { response.status(401).json({ error: "Unauthorized" }); return; }
    next();
  };
  app.post(RELATIONSHIP_CANCELLATION_PATH, guard, (request: Request, response: Response, next: NextFunction) => {
    parse(request, response, error => {
      if (error) { response.status(400).json({ accepted: false, code: "INVALID_EVENT", error: "Invalid event" }); return; }
      next();
    });
  });
  app.get(`${RELATIONSHIP_CANCELLATION_PATH}/:protocol`, guard);
}

export function registerRelationshipCancellationReceiver(app: Express, integrationKey: string | undefined, enabled: boolean) {
  const safe = (handler: (request: Request, response: Response) => Promise<void>) => async (request: Request, response: Response) => {
    if (!enabled || !integrationKey?.trim()) { response.status(404).json({ error: "Not found" }); return; }
    try { await handler(request, response); }
    catch (error) {
      logger.error("Relationship cancellation endpoint failed outside the handler", { errorName: error instanceof Error ? error.name : "non-Error" });
      if (!response.headersSent) response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" });
    }
  };
  app.post(RELATIONSHIP_CANCELLATION_PATH, safe(handlePost));
  app.get(`${RELATIONSHIP_CANCELLATION_PATH}/:protocol`, safe(handleGet));
}
