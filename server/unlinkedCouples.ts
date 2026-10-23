import type { Express, NextFunction, Request, Response } from "express";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { auditLogs, captureRecords, customers } from "../drizzle/schema";
import { encounterTimesSchema, ENCOUNTER_TIMES_PATH } from "./encounterTimesReceiver";
import { getDb } from "./db";
import { isDuplicateKeyError } from "./mysqlErrors";
import { logger } from "./logger";

/**
 * F1.4: casal sem vínculo nunca é DEAD silencioso. Dois lados do mesmo problema, os dois visíveis no painel da sala:
 *  - CÓDIGO SEM FICHA: o Sales mandou os tempos de um casal (CP-…) e o CRM respondeu 422 UNKNOWN_COUPLE_CODE. Cada recusa vira uma linha de auditoria (uma por eventId, então as
 *    retentativas do Sales por até 6 h não enchem a tabela). Some do painel quando alguma ficha passa a ter o código.
 *  - FICHA SEM CÓDIGO: a recepção fez o check-in e a ficha segue sem o código do casal, então os tempos que o Sales mandar vão recusar.
 * Sem PII: o código do casal é público (aparece na tela da sala) e a trilha guarda só código e eventId. O corpo do evento nunca é gravado.
 * Esta observação NÃO altera o receptor encounterTimesReceiver.ts (travado por hash na Suite): ela só olha a resposta 422 da rota.
 */
export const UNKNOWN_COUPLE_ACTION = "encounter_times_unknown_couple" as const;
export const UNKNOWN_COUPLE_ENTITY = "couple_code" as const;
/** Janela do painel: bem maior que as 6 h de retentativa do Sales, para o alerta sobreviver a uma troca de turno. */
export const UNLINKED_WINDOW_HOURS = 24;
const LIST_LIMIT = 100;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Grava a recusa (idempotente por eventId). Falha aqui nunca derruba nem atrasa a resposta ao Sales. */
export async function recordUnknownCoupleRefusal(db: Db, input: { coupleCode: string; eventId: string }) {
  try {
    await db.insert(auditLogs).values({
      actorUserId: null, entityType: UNKNOWN_COUPLE_ENTITY, entityId: input.coupleCode.slice(0, 80), action: UNKNOWN_COUPLE_ACTION,
      summary: "Tempos de sala recusados: nenhuma ficha com este código do casal. Ligue o código à ficha para o Sales reenviar.",
      idempotencyKey: `audit:encounter-times-unknown:${input.eventId}`.slice(0, 200),
    });
    return true;
  } catch (error) {
    // Chave repetida = a retentativa do mesmo evento: esperado. Qualquer outra falha só vai para o log (sem corpo, sem código).
    if (!isDuplicateKeyError(error)) logger.warn("Unknown couple refusal not recorded", { errorName: error instanceof Error ? error.name : "non-Error" });
    return false;
  }
}

/**
 * Observa a resposta da rota dos tempos: 422 nessa rota só pode ser UNKNOWN_COUPLE_CODE (o conflito de eventId é 409). Registrada ANTES do receptor; não lê nem muda nada da requisição.
 * Só vale com o receptor ligado (mesma flag): desligado, a rota é 404 e nada é observado.
 */
export function registerUnknownCoupleWatch(app: Express, enabled: boolean) {
  if (!enabled) return;
  app.post(ENCOUNTER_TIMES_PATH, (request: Request, response: Response, next: NextFunction) => {
    response.on("finish", () => {
      if (response.statusCode !== 422) return;
      const parsed = encounterTimesSchema.safeParse(request.body);
      if (!parsed.success) return;
      void getDb().then(db => (db ? recordUnknownCoupleRefusal(db, { coupleCode: parsed.data.coupleCode, eventId: parsed.data.eventId }) : false)).catch(() => undefined);
    });
    next();
  });
}

export type UnlinkedCouples = {
  windowHours: number;
  /** Códigos que o Sales tentou entregar e que nenhuma ficha tem. */
  codesWithoutCapture: Array<{ coupleCode: string; attempts: number; firstSeenAt: Date; lastSeenAt: Date }>;
  /** Fichas com chegada recente e sem código do casal. */
  capturesWithoutCode: Array<{ captureId: number; customerName: string; salesRoom: string | null; checkedInAt: Date | null }>;
  total: number;
};

/** `roomVisible`: recorte de visibilidade da sala (roomVisibleCondition) para quem não abre fichas arquivadas; sem ele a lista é completa (administração e financeiro). */
export async function listUnlinkedCouples(db: Db, now: Date = new Date(), windowHours = UNLINKED_WINDOW_HOURS, roomVisible?: SQL): Promise<UnlinkedCouples> {
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  const refusals = await db.select({ coupleCode: auditLogs.entityId, attempts: sql<number>`COUNT(*)`, firstSeenAt: sql<Date>`MIN(${auditLogs.createdAt})`, lastSeenAt: sql<Date>`MAX(${auditLogs.createdAt})` })
    .from(auditLogs).where(and(eq(auditLogs.entityType, UNKNOWN_COUPLE_ENTITY), eq(auditLogs.action, UNKNOWN_COUPLE_ACTION), gte(auditLogs.createdAt, since)))
    .groupBy(auditLogs.entityId).orderBy(desc(sql`MAX(${auditLogs.createdAt})`)).limit(LIST_LIMIT);
  const linked = refusals.length ? await db.select({ coupleCode: captureRecords.coupleCode }).from(captureRecords).where(inArray(captureRecords.coupleCode, refusals.map(row => row.coupleCode))) : [];
  // O MySQL compara o código sem diferenciar maiúsculas (cp-1234 = CP-1234): o Set precisa fazer o mesmo.
  const linkedCodes = new Set(linked.map(row => (row.coupleCode ?? "").toUpperCase()));
  const codesWithoutCapture = refusals.filter(row => !linkedCodes.has(row.coupleCode.toUpperCase())).map(row => ({ coupleCode: row.coupleCode, attempts: Number(row.attempts), firstSeenAt: new Date(row.firstSeenAt), lastSeenAt: new Date(row.lastSeenAt) }));
  const capturesWithoutCode = await db.select({ captureId: captureRecords.id, customerName: customers.fullName, salesRoom: captureRecords.salesRoom, checkedInAt: captureRecords.checkedInAt })
    .from(captureRecords).innerJoin(customers, eq(customers.id, captureRecords.customerId))
    .where(and(isNull(captureRecords.coupleCode), isNull(captureRecords.anonymizedAt), isNotNull(captureRecords.checkedInAt), gte(captureRecords.checkedInAt, since), roomVisible))
    .orderBy(desc(captureRecords.checkedInAt)).limit(LIST_LIMIT);
  return { windowHours, codesWithoutCapture, capturesWithoutCode, total: codesWithoutCapture.length + capturesWithoutCode.length };
}
