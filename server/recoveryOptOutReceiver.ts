import { createHash, timingSafeEqual } from "node:crypto";
import { eligibilityHook } from "./nonBuyerEligibilityService";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, captureRecords, customerContactOptouts } from "../drizzle/schema";
import { getDb } from "./db";
import { isDuplicateKeyError, withDeadlockRetry } from "./mysqlErrors";
import { logger } from "./logger";

/**
 * C2/C3 fatia 2: receptor de `recovery.opted_out.v1` (Recovery -> CRM), desenho §4.3. O Recovery avisa que o casal não quer mais contato; o CRM grava o opt-out
 * (append-only, por cliente) e a elegibilidade o respeita (nonBuyerEligibility, `readOptOut`). A revogação `crm.non_buyer.eligibility_revoked.v1` NÃO sai aqui:
 * vem com a projeção e os ganchos (fatias 3/4). DESLIGADO por padrão (RECOVERY_ELIGIBILITY_ENABLED): 404 mesmo com a chave certa; sem RECOVERY_INTEGRATION_KEY também 404.
 * - 401 sem/errada chave ANTES de ler o corpo (portão montado acima do parser global); com chave, corpo ruim = 400 INVALID_EVENT.
 * - idempotente por eventId: replay 200, mesmo eventId com corpo diferente 409 EVENT_ID_CONFLICT; casal desconhecido 422 UNKNOWN_COUPLE_CODE (não reenviável).
 * - Sem PII: o corpo só tem código do casal, instante e origem. Opt-out é definitivo aqui (reativação depende de decisão do Lucas, pendente).
 */
export const RECOVERY_OPTOUT_PATH = "/api/integrations/recovery/opt-out";

const instant = z.string().datetime().refine(value => { const ms = Date.parse(value); return ms >= Date.parse("2000-01-01T00:00:00Z") && ms <= Date.parse("2037-12-31T23:59:59Z"); }, "Horário fora da faixa aceita.");
export const recoveryOptOutSchema = z.strictObject({
  eventId: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/),
  coupleCode: z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/),
  optedOutAt: instant,
  source: z.literal("recovery"),
});
export type RecoveryOptOut = z.infer<typeof recoveryOptOutSchema>;

export class RecoveryOptOutRejection extends Error {
  constructor(readonly code: "UNKNOWN_COUPLE_CODE" | "EVENT_ID_CONFLICT", message: string) { super(message); this.name = "RecoveryOptOutRejection"; }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
export const recoveryOptOutHash = (event: RecoveryOptOut) => createHash("sha256").update(JSON.stringify([event.eventId, event.coupleCode, event.optedOutAt, event.source])).digest("hex");

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Grava o opt-out (uma linha + trilha) na mesma transação. Idempotente por eventId. */
export async function recordRecoveryOptOut(db: Db, event: RecoveryOptOut): Promise<{ replay: boolean; optOutId: number; customerId: number }> {
  const hash = recoveryOptOutHash(event);
  const existing = async (executor: Db | Tx) => (await executor.select({ id: customerContactOptouts.id, customerId: customerContactOptouts.customerId, payloadHash: customerContactOptouts.payloadHash }).from(customerContactOptouts).where(eq(customerContactOptouts.eventId, event.eventId)).limit(1))[0];
  const settle = (row: NonNullable<Awaited<ReturnType<typeof existing>>>) => {
    if (row.payloadHash !== hash) throw new RecoveryOptOutRejection("EVENT_ID_CONFLICT", "O eventId já foi usado com outro conteúdo.");
    return { replay: true, optOutId: row.id, customerId: row.customerId };
  };
  const seen = await existing(db);
  if (seen) return settle(seen);
  try {
    return await withDeadlockRetry(() => db.transaction(async tx => {
      const [capture] = await tx.select({ id: captureRecords.id, customerId: captureRecords.customerId }).from(captureRecords).where(eq(captureRecords.coupleCode, event.coupleCode)).limit(1);
      if (!capture) throw new RecoveryOptOutRejection("UNKNOWN_COUPLE_CODE", "Código do casal desconhecido.");
      const [{ id }] = await tx.insert(customerContactOptouts).values({
        customerId: capture.customerId, coupleCode: event.coupleCode, optedOutAt: new Date(event.optedOutAt), source: "recovery", eventId: event.eventId, payloadHash: hash,
      }).$returningId();
      await tx.insert(auditLogs).values({
        actorUserId: null, entityType: "capture", entityId: String(capture.id), action: "recovery_opt_out_received",
        summary: `Opt-out de contato recebido do Recovery (evento ${event.eventId}).`, idempotencyKey: `audit:recovery-optout:${event.eventId}`,
      });
      await eligibilityHook(tx, { customerId: capture.customerId }); // C2/C3: opt-out tem efeito imediato e revoga. Último passo da tx.
      return { replay: false, optOutId: id, customerId: capture.customerId };
    }));
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await existing(db);
      if (raced) return settle(raced);
    }
    throw error;
  }
}

async function handle(request: Request, response: Response, integrationKey: string) {
  const authorization = request.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied || !safeEqual(supplied, integrationKey)) { response.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = recoveryOptOutSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ accepted: false, code: "INVALID_EVENT", error: "Invalid event" }); return; }
  const db = await getDb();
  if (!db) { response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Database unavailable" }); return; }
  try {
    const result = await recordRecoveryOptOut(db, parsed.data);
    response.status(result.replay ? 200 : 201).json({ accepted: true, replay: result.replay, eventId: parsed.data.eventId });
  } catch (error) {
    if (error instanceof RecoveryOptOutRejection) {
      logger.warn("Recovery opt-out rejected by a domain rule", { code: error.code, eventId: parsed.data.eventId });
      response.status(error.code === "EVENT_ID_CONFLICT" ? 409 : 422).json({ accepted: false, code: error.code, error: error.message });
      return;
    }
    logger.error("Recovery opt-out ingest failed", { eventId: parsed.data.eventId, errorName: error instanceof Error ? error.name : "non-Error" });
    response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" });
  }
}

/** Portão ANTES do parser JSON global, só para esta rota: 404 (flag off/sem chave), 401 sem ler o corpo, com chave corpo lido com limite de 16 KB (JSON ruim = 400). */
export function registerRecoveryOptOutGate(app: Express, integrationKey: string | undefined, enabled: boolean) {
  const parse = express.json({ limit: "16kb" });
  app.post(RECOVERY_OPTOUT_PATH, (request: Request, response: Response, next: NextFunction) => {
    const key = integrationKey?.trim();
    if (!enabled || !key) { response.status(404).json({ error: "Not found" }); return; }
    const authorization = request.get("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!supplied || !safeEqual(supplied, key)) { response.status(401).json({ error: "Unauthorized" }); return; }
    parse(request, response, error => {
      if (error) { response.status(400).json({ accepted: false, code: "INVALID_EVENT", error: "Invalid event" }); return; }
      next();
    });
  });
}

export function registerRecoveryOptOutReceiver(app: Express, integrationKey: string | undefined, enabled: boolean) {
  app.post(RECOVERY_OPTOUT_PATH, async (request, response) => {
    const key = integrationKey?.trim();
    if (!enabled || !key) { response.status(404).json({ error: "Not found" }); return; }
    try { await handle(request, response, key); }
    catch (error) {
      logger.error("Recovery opt-out ingest failed outside the handler", { errorName: error instanceof Error ? error.name : "non-Error" });
      if (!response.headersSent) response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" });
    }
  });
}
