import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, captureRecords, encounterTimeRecords } from "../drizzle/schema";
import { getDb } from "./db";
import { isDuplicateKeyError, withDeadlockRetry } from "./mysqlErrors";
import { logger } from "./logger";

/**
 * Receptor de `encounter.times_recorded.v1`: o Sales Command (dono da operação de sala) manda os tempos de espera,
 * consultor e fechador de um casal; o CRM só guarda, chaveado pelo código do casal. Só adiciona: nenhuma ficha é alterada.
 * Contrato PROPOSTO (a Frente C confirma): o Sales ainda não emite este evento.
 * - eventId único: reenvio idêntico responde 200 replay; mesmo eventId com corpo diferente responde 409.
 * - código do casal desconhecido: 422 UNKNOWN_COUPLE_CODE (recusa de domínio, o Sales para de tentar e revisa).
 */
export const ENCOUNTER_TIMES_PATH = "/api/integrations/sales-command/encounter-times";

const instant = z.string().datetime();
export const encounterTimesSchema = z.strictObject({
  eventId: z.string().trim().min(1).max(120),
  eventName: z.literal("encounter.times_recorded.v1"),
  source: z.literal("sales-command"),
  correlationId: z.string().trim().min(1).max(120),
  occurredAt: instant,
  coupleCode: z.string().trim().min(1).max(64),
  times: z.strictObject({
    waitStartedAt: instant.optional(),
    waitEndedAt: instant.optional(),
    consultantStartedAt: instant.optional(),
    consultantEndedAt: instant.optional(),
    consultantDispensed: z.boolean().optional(),
    closerStartedAt: instant.optional(),
    closerEndedAt: instant.optional(),
    endedAt: instant.optional(),
  }),
}).superRefine((event, ctx) => {
  const t = event.times;
  const pairs: Array<[keyof typeof t, keyof typeof t]> = [["waitStartedAt", "waitEndedAt"], ["consultantStartedAt", "consultantEndedAt"], ["closerStartedAt", "closerEndedAt"]];
  for (const [start, end] of pairs) {
    const a = t[start], b = t[end];
    if (typeof a === "string" && typeof b === "string" && Date.parse(b) < Date.parse(a)) ctx.addIssue({ code: "custom", path: ["times", end], message: "O fim vem antes do início." });
  }
  // O fim do atendimento não pode vir antes de nenhuma etapa registrada.
  if (typeof t.endedAt === "string") {
    const end = Date.parse(t.endedAt);
    const stages = [t.waitStartedAt, t.waitEndedAt, t.consultantStartedAt, t.consultantEndedAt, t.closerStartedAt, t.closerEndedAt];
    if (stages.some(value => typeof value === "string" && Date.parse(value) > end)) ctx.addIssue({ code: "custom", path: ["times", "endedAt"], message: "O fim do atendimento vem antes de uma etapa." });
  }
  if (!Object.values(t).some(value => typeof value === "string")) ctx.addIssue({ code: "custom", path: ["times"], message: "Nenhum horário informado." });
});
export type EncounterTimesEvent = z.infer<typeof encounterTimesSchema>;

export class EncounterTimesRejection extends Error {
  constructor(readonly code: "UNKNOWN_COUPLE_CODE" | "EVENT_ID_CONFLICT", message: string) { super(message); this.name = "EncounterTimesRejection"; }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
const toDate = (value?: string) => (value ? new Date(value) : null);

/** Hash estável do corpo: o replay só vale se o conteúdo for o mesmo. */
export function encounterTimesHash(event: EncounterTimesEvent) {
  const t = event.times;
  return createHash("sha256").update(JSON.stringify([event.coupleCode, event.correlationId, event.occurredAt, t.waitStartedAt ?? null, t.waitEndedAt ?? null, t.consultantStartedAt ?? null, t.consultantEndedAt ?? null, t.consultantDispensed ?? false, t.closerStartedAt ?? null, t.closerEndedAt ?? null, t.endedAt ?? null])).digest("hex");
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Grava o evento (uma linha + trilha) na mesma transação. Idempotente por eventId. */
export async function recordEncounterTimes(db: Db, event: EncounterTimesEvent): Promise<{ replay: boolean; captureId: number; recordId: number }> {
  const hash = encounterTimesHash(event);
  const existing = async (executor: Db | Tx) => (await executor.select({ id: encounterTimeRecords.id, captureId: encounterTimeRecords.captureId, payloadHash: encounterTimeRecords.payloadHash }).from(encounterTimeRecords).where(eq(encounterTimeRecords.eventId, event.eventId)).limit(1))[0];
  const settle = (row: NonNullable<Awaited<ReturnType<typeof existing>>>) => {
    if (row.payloadHash !== hash) throw new EncounterTimesRejection("EVENT_ID_CONFLICT", "O eventId já foi usado com outro conteúdo.");
    return { replay: true, captureId: row.captureId, recordId: row.id };
  };
  const seen = await existing(db);
  if (seen) return settle(seen);
  try {
    return await withDeadlockRetry(() => db.transaction(async tx => {
      const [capture] = await tx.select({ id: captureRecords.id }).from(captureRecords).where(eq(captureRecords.coupleCode, event.coupleCode)).limit(1);
      if (!capture) throw new EncounterTimesRejection("UNKNOWN_COUPLE_CODE", "Código do casal desconhecido.");
      const t = event.times;
      const [{ id }] = await tx.insert(encounterTimeRecords).values({
        eventId: event.eventId, captureId: capture.id, coupleCode: event.coupleCode, correlationId: event.correlationId, payloadHash: hash,
        occurredAt: new Date(event.occurredAt),
        waitStartedAt: toDate(t.waitStartedAt), waitEndedAt: toDate(t.waitEndedAt),
        consultantStartedAt: toDate(t.consultantStartedAt), consultantEndedAt: toDate(t.consultantEndedAt), consultantDispensed: t.consultantDispensed ?? false,
        closerStartedAt: toDate(t.closerStartedAt), closerEndedAt: toDate(t.closerEndedAt), endedAt: toDate(t.endedAt),
      }).$returningId();
      await tx.insert(auditLogs).values({
        actorUserId: null, entityType: "capture", entityId: String(capture.id), action: "encounter_times_received",
        summary: `Tempos de sala recebidos do Sales Command (evento ${event.eventId}).`, idempotencyKey: `audit:encounter-times:${event.eventId}`,
      });
      return { replay: false, captureId: capture.id, recordId: id };
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
  const parsed = encounterTimesSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: "Invalid event" }); return; }
  const db = await getDb();
  if (!db) { response.status(503).json({ error: "Database unavailable" }); return; }
  try {
    const result = await recordEncounterTimes(db, parsed.data);
    response.status(result.replay ? 200 : 201).json({ accepted: true, replay: result.replay, eventId: parsed.data.eventId, coupleCode: parsed.data.coupleCode });
  } catch (error) {
    if (error instanceof EncounterTimesRejection) {
      logger.warn("Encounter times rejected by a domain rule", { code: error.code, eventId: parsed.data.eventId });
      response.status(error.code === "EVENT_ID_CONFLICT" ? 409 : 422).json({ accepted: false, code: error.code, error: error.message });
      return;
    }
    logger.error("Encounter times ingest failed", { eventId: parsed.data.eventId, errorName: error instanceof Error ? error.name : "non-Error" });
    response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" });
  }
}

export function registerEncounterTimesReceiver(app: Express, integrationKey: string | undefined) {
  app.post(ENCOUNTER_TIMES_PATH, async (request, response) => {
    const key = integrationKey?.trim();
    if (!key) { response.status(503).json({ error: "Integration unavailable" }); return; }
    try { await handle(request, response, key); }
    catch (error) {
      logger.error("Encounter times ingest failed outside the handler", { errorName: error instanceof Error ? error.name : "non-Error" });
      if (!response.headersSent) response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" });
    }
  });
}
