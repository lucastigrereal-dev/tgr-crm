import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { attendanceRecords, auditLogs, coupleRegistry, resorts } from "../drizzle/schema";
import { getDb } from "./db";
import { isDuplicateKeyError, withDeadlockRetry } from "./mysqlErrors";
import { logger } from "./logger";

/**
 * C1: receptor de `encounter.attendance_recorded.v1` (Sales Command -> CRM): um evento por atendimento encerrado, qualquer desfecho.
 * O CRM mantém o registro canônico do casal (couple_registry) e o histórico (attendance_records). Contrato dono: tgr-commercial-suite (seção `attendance`
 * de shared/contracts/consumers.lock.json). DESLIGADO por padrão (ATTENDANCE_RECEIVER_ENABLED): 404 mesmo com a chave certa.
 * - eventId determinístico de (encounterId, revisão): o receptor recusa (400) qualquer outro. Mesmo eventId + mesmo corpo = 200 replay; corpo diferente = 409.
 * - projeto desconhecido (nenhum resort com esse externalKey): 422 UNKNOWN_PROJECT. O receptor NÃO cria resort nem toca ficha/cliente/contrato.
 * - PII mínima: nomes e telefone só em dígitos, só em couple_registry. Resposta, log e auditoria não carregam nome nem telefone.
 */
export const ATTENDANCE_TOPIC = "encounter.attendance_recorded.v1";
export const ATTENDANCE_PATH = "/api/integrations/sales-command/encounter-outcome";
export const ATTENDANCE_OUTCOMES = ["SALE_CONFIRMED", "NO_SALE", "CAIU_EM_MESA", "NT"] as const;

/** UUID determinístico (forma v5) do par (atendimento, revisão); mesma regra do emissor (Suite). */
export function attendanceEventId(encounterId: string, revision: number): string {
  const hex = createHash("sha1").update(`${ATTENDANCE_TOPIC}:${encounterId}:${revision}`).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

// Colunas timestamp do MySQL só vão de 1970 a 2038: fora de 2000..2037 vira 400 (recusa), não 503 (que o Sales repetiria para sempre).
const instant = z.string().datetime().refine(value => { const ms = Date.parse(value); return ms >= Date.parse("2000-01-01T00:00:00Z") && ms <= Date.parse("2037-12-31T23:59:59Z"); }, "Horário fora da faixa aceita.");
const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);

export const attendanceSchema = z.strictObject({
  eventId: uuid,
  eventName: z.literal(ATTENDANCE_TOPIC),
  source: z.literal("sales-command"),
  correlationId: text(128),
  occurredAt: instant,
  project: z.strictObject({ externalKey: uuid, name: text(160), timezone: text(64) }),
  encounterId: uuid,
  coupleId: uuid,
  coupleCode: text(32),
  couple: z.strictObject({ primaryName: text(160).optional(), secondaryName: text(160).optional(), phone: text(64).optional() }),
  outcome: z.enum(ATTENDANCE_OUTCOMES),
  reasonCode: text(100).optional(),
  closedAt: instant,
  revision: z.number().int().min(0).max(1000),
}).superRefine((event, ctx) => {
  if (event.outcome === "SALE_CONFIRMED" && event.reasonCode !== undefined) ctx.addIssue({ code: "custom", path: ["reasonCode"], message: "reasonCode não vale com SALE_CONFIRMED." });
  if (event.eventId !== attendanceEventId(event.encounterId, event.revision)) ctx.addIssue({ code: "custom", path: ["eventId"], message: "eventId deve ser o derivado de (encounterId, revision)." });
});
export type AttendanceEvent = z.infer<typeof attendanceSchema>;

export class AttendanceRejection extends Error {
  constructor(readonly code: "UNKNOWN_PROJECT" | "EVENT_ID_CONFLICT", message: string) { super(message); this.name = "AttendanceRejection"; }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
const digitsOf = (phone?: string) => { const digits = (phone ?? "").replace(/\D/g, ""); return digits || null; };

/** Hash estável do corpo inteiro: o replay só vale se o conteúdo for o mesmo. */
export function attendanceHash(event: AttendanceEvent) {
  const c = event.couple;
  return createHash("sha256").update(JSON.stringify([event.eventId, event.correlationId, event.occurredAt, event.project.externalKey, event.project.name, event.project.timezone, event.encounterId, event.coupleId, event.coupleCode,
    c.primaryName ?? null, c.secondaryName ?? null, c.phone ?? null, event.outcome, event.reasonCode ?? null, event.closedAt, event.revision])).digest("hex");
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type AttendanceResult = { replay: boolean; coupleRegistryId: number; recordId: number };

/** Grava o evento na mesma transação (casal + atendimento + trilha). Idempotente por eventId. */
export async function recordAttendance(db: Db, event: AttendanceEvent, retried = false): Promise<AttendanceResult> {
  const hash = attendanceHash(event);
  const existing = async (executor: Db | Tx) => (await executor.select({ id: attendanceRecords.id, coupleRegistryId: attendanceRecords.coupleRegistryId, payloadHash: attendanceRecords.payloadHash }).from(attendanceRecords).where(eq(attendanceRecords.eventId, event.eventId)).limit(1))[0];
  const settle = (row: NonNullable<Awaited<ReturnType<typeof existing>>>): AttendanceResult => {
    if (row.payloadHash !== hash) throw new AttendanceRejection("EVENT_ID_CONFLICT", "O eventId já foi usado com outro conteúdo.");
    return { replay: true, coupleRegistryId: row.coupleRegistryId, recordId: row.id };
  };
  const seen = await existing(db);
  if (seen) return settle(seen);
  try {
    return await withDeadlockRetry(() => db.transaction(async tx => {
      const [resort] = await tx.select({ id: resorts.id }).from(resorts).where(eq(resorts.externalKey, event.project.externalKey)).limit(1);
      if (!resort) throw new AttendanceRejection("UNKNOWN_PROJECT", "Projeto desconhecido.");
      const closedAt = new Date(event.closedAt);
      const names = { primaryName: event.couple.primaryName ?? null, secondaryName: event.couple.secondaryName ?? null, phoneDigits: digitsOf(event.couple.phone) };
      const [current] = await tx.select().from(coupleRegistry).where(and(eq(coupleRegistry.resortId, resort.id), eq(coupleRegistry.salesCoupleId, event.coupleId))).limit(1).for("update");
      let registryId: number;
      if (!current) {
        [{ id: registryId }] = await tx.insert(coupleRegistry).values({
          resortId: resort.id, salesCoupleId: event.coupleId, coupleCode: event.coupleCode, ...names, lastEncounterId: event.encounterId, lastRevision: event.revision,
          lastOutcome: event.outcome, lastReasonCode: event.reasonCode ?? null, lastClosedAt: closedAt, encountersCount: 1,
        }).$returningId();
      } else {
        registryId = current.id;
        const [sameEncounter] = await tx.select({ id: attendanceRecords.id }).from(attendanceRecords).where(and(eq(attendanceRecords.coupleRegistryId, current.id), eq(attendanceRecords.encounterId, event.encounterId))).limit(1);
        // O estado "último" é do atendimento mais recente por encerramento; dentro do mesmo atendimento vale a maior revisão (correção).
        // closedAt tem precisão de milissegundo (timestamp(3)); empate exato entre atendimentos distintos desempata pelo maior encounterId, igual em qualquer ordem de chegada.
        const newer = event.encounterId === current.lastEncounterId ? event.revision > current.lastRevision
          : closedAt.getTime() !== current.lastClosedAt.getTime() ? closedAt.getTime() > current.lastClosedAt.getTime() : event.encounterId > current.lastEncounterId;
        await tx.update(coupleRegistry).set({
          encountersCount: sameEncounter ? current.encountersCount : current.encountersCount + 1,
          ...(newer ? {
            coupleCode: event.coupleCode, primaryName: names.primaryName ?? current.primaryName, secondaryName: names.secondaryName ?? current.secondaryName, phoneDigits: names.phoneDigits ?? current.phoneDigits,
            lastEncounterId: event.encounterId, lastRevision: event.revision, lastOutcome: event.outcome, lastReasonCode: event.reasonCode ?? null, lastClosedAt: closedAt,
          } : {}),
        }).where(eq(coupleRegistry.id, current.id));
      }
      const [{ id }] = await tx.insert(attendanceRecords).values({
        eventId: event.eventId, coupleRegistryId: registryId, encounterId: event.encounterId, revision: event.revision, outcome: event.outcome, reasonCode: event.reasonCode ?? null,
        closedAt, occurredAt: new Date(event.occurredAt), correlationId: event.correlationId, payloadHash: hash,
      }).$returningId();
      await tx.insert(auditLogs).values({
        actorUserId: null, entityType: "couple_registry", entityId: String(registryId), action: "attendance_received",
        summary: `Atendimento recebido do Sales Command (evento ${event.eventId}, desfecho ${event.outcome}, revisão ${event.revision}).`, idempotencyKey: `audit:attendance:${event.eventId}`,
      });
      return { replay: false, coupleRegistryId: registryId, recordId: id };
    }));
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await existing(db);
      if (raced) return settle(raced);
      // Outro evento do mesmo casal criou o registro primeiro (unique resort+casal): uma nova tentativa já o encontra e o atualiza.
      if (!retried) return recordAttendance(db, event, true);
    }
    throw error;
  }
}

async function handle(request: Request, response: Response, integrationKey: string) {
  const authorization = request.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied || !safeEqual(supplied, integrationKey)) { response.status(401).json({ error: "Unauthorized" }); return; }
  const parsed = attendanceSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ accepted: false, code: "INVALID_EVENT", error: "Invalid event" }); return; }
  const db = await getDb();
  if (!db) { response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Database unavailable" }); return; }
  try {
    const result = await recordAttendance(db, parsed.data);
    response.status(result.replay ? 200 : 201).json({ accepted: true, replay: result.replay, eventId: parsed.data.eventId });
  } catch (error) {
    if (error instanceof AttendanceRejection) {
      logger.warn("Attendance rejected by a domain rule", { code: error.code, eventId: parsed.data.eventId });
      response.status(error.code === "EVENT_ID_CONFLICT" ? 409 : 422).json({ accepted: false, code: error.code, error: error.message });
      return;
    }
    logger.error("Attendance ingest failed", { eventId: parsed.data.eventId, errorName: error instanceof Error ? error.name : "non-Error" });
    response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" });
  }
}

/**
 * Portão leve ANTES do parser JSON global (montado em server/_core/index.ts acima de express.json) só para ESTA rota: flag desligada ou sem chave = 404;
 * chave ausente/errada = 401 sem ler o corpo (JSON malformado ou enorme sem chave não chega ao parser); com chave, o corpo é lido aqui com limite pequeno
 * (o evento tem poucos KB) e JSON malformado/grande vira 400 INVALID_EVENT. O parser global pula o corpo já lido. Não toca nenhuma outra rota.
 */
export function registerAttendanceGate(app: Express, integrationKey: string | undefined, enabled: boolean) {
  const parse = express.json({ limit: "64kb" });
  app.post(ATTENDANCE_PATH, (request: Request, response: Response, next: NextFunction) => {
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

export function registerAttendanceReceiver(app: Express, integrationKey: string | undefined, enabled: boolean) {
  app.post(ATTENDANCE_PATH, async (request, response) => {
    // DESLIGADO por padrão (ATTENDANCE_RECEIVER_ENABLED) e sem chave configurada: 404 como se a rota não existisse (contrato do Sales: 404 = desligada ou sem chave).
    const key = integrationKey?.trim();
    if (!enabled || !key) { response.status(404).json({ error: "Not found" }); return; }
    try { await handle(request, response, key); }
    catch (error) {
      logger.error("Attendance ingest failed outside the handler", { errorName: error instanceof Error ? error.name : "non-Error" });
      if (!response.headersSent) response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" });
    }
  });
}
