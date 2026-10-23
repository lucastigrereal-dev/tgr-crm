import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { contractRescueAttempts, contractRescueCases, contracts, domainEvents, installmentRenegotiations, installments, retentionSettingsVersions, salesCommissions } from "../drizzle/schema";
import type { getDb } from "./db";
import { withDeadlockRetry } from "./mysqlErrors";
import { txAudit, txEvent, type Tx } from "./txOutbox";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * F3.1: resgate pelo pós-vendas e distrato automático em MODO SOMBRA (docs/design/DISTRATO_E_RESGATE.md).
 * O módulo REGISTRA (casos, tentativas, eventos internos, "teria distratado") e NUNCA age: não há aqui importação de `executeCancellation`, de pedido de distrato nem de nenhum
 * efeito sobre contrato, parcela, comissão ou estoque (um teste de varredura do código-fonte trava isso). Distrato automático real é F4, com GO.
 * Valores padrão são PROVISÓRIOS: aguardam o modelo de contrato do Lucas (o ponto de encaixe é `reason = 'reservation_expired'`, ainda sem uso).
 */

export const RETENTION_DEFAULTS = {
  rescueWindowMonths: 3, rescueAlertLeadDays: 15, autoCancelEnabled: false, rescueReopenAfterDays: 90, autoCancelPromiseDays: 15, autoCancelMaxPaidPercent: 30,
} as const;
/** Todos os padrões acima são provisórios (modelo de contrato do Lucas ainda não chegou). A tela marca isto. */
export const RETENTION_PROVISIONAL = true;

export const retentionSettingsInput = z.object({
  rescueWindowMonths: z.number().int().min(1).max(24),
  rescueAlertLeadDays: z.number().int().min(0).max(365),
  autoCancelEnabled: z.boolean(),
  rescueReopenAfterDays: z.number().int().min(1).max(730),
  autoCancelPromiseDays: z.number().int().min(0).max(365),
  autoCancelMaxPaidPercent: z.number().int().min(0).max(100),
  note: z.string().trim().max(500).optional(),
});
export type RetentionSettings = Omit<z.infer<typeof retentionSettingsInput>, "note">;

export type CurrentRetentionSettings = RetentionSettings & { versionId: number | null; isDefault: boolean; provisional: boolean };

export async function currentRetentionSettings(db: Db): Promise<CurrentRetentionSettings> {
  const [row] = await db.select().from(retentionSettingsVersions).orderBy(desc(retentionSettingsVersions.id)).limit(1);
  if (!row) return { ...RETENTION_DEFAULTS, versionId: null, isDefault: true, provisional: RETENTION_PROVISIONAL };
  return {
    rescueWindowMonths: row.rescueWindowMonths, rescueAlertLeadDays: row.rescueAlertLeadDays, autoCancelEnabled: row.autoCancelEnabled, rescueReopenAfterDays: row.rescueReopenAfterDays,
    autoCancelPromiseDays: row.autoCancelPromiseDays, autoCancelMaxPaidPercent: row.autoCancelMaxPaidPercent, versionId: row.id, isDefault: false, provisional: RETENTION_PROVISIONAL,
  };
}

const describeSettings = (s: RetentionSettings) => `prazo ${s.rescueWindowMonths} mês(es), alerta ${s.rescueAlertLeadDays} dia(s) antes, reabertura após ${s.rescueReopenAfterDays} dia(s), teto de promessa ${s.autoCancelPromiseDays} dia(s), teto de valor pago ${s.autoCancelMaxPaidPercent}%, distrato automático (só registro) ${s.autoCancelEnabled ? "LIGADO" : "desligado"}`;

export async function saveRetentionSettings(db: Db, actorUserId: number, input: z.infer<typeof retentionSettingsInput>) {
  const { note, ...values } = input;
  return withDeadlockRetry(() => db.transaction(async tx => {
    const [{ id }] = await tx.insert(retentionSettingsVersions).values({ ...values, note: note || null, createdByUserId: actorUserId }).$returningId();
    await txAudit(tx, { actorUserId, entityType: "retention_settings", entityId: id, action: "version_saved", summary: `Configuração de resgate/distrato (modo sombra): ${describeSettings(values)}. Vale para casos abertos depois.` });
    return { versionId: Number(id) };
  }));
}

export type CeilingFacts = { hasPaidCommission: boolean; hasOpenRenegotiation: boolean; recentPromise: boolean; paidPercent: number };
export type ManualReviewReason = "paid_commission" | "open_renegotiation" | "recent_promise" | "over_cap";

/** Tetos da seção 10 do desenho: o primeiro que barra define o motivo da revisão manual (ordem fixa e determinística). Sem teto violado = "teria rodado". */
export function evaluateCeilings(facts: CeilingFacts, settings: Pick<RetentionSettings, "autoCancelMaxPaidPercent">): ManualReviewReason | null {
  if (facts.hasPaidCommission) return "paid_commission";
  if (facts.hasOpenRenegotiation) return "open_renegotiation";
  if (facts.recentPromise) return "recent_promise";
  if (facts.paidPercent > settings.autoCancelMaxPaidPercent) return "over_cap";
  return null;
}

const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const dateOnly = (value: Date | string) => (typeof value === "string" ? value.slice(0, 10) : isoDate(value));

/** Fim do prazo = primeira parcela vencida e não paga + N meses (limitado ao último dia do mês de destino). */
export function rescueDueAtFor(firstOverdueDate: string, windowMonths: number): Date {
  const [y, m, d] = firstOverdueDate.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + windowMonths, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay)));
}

export type SweepOutcome = { opened: number; rescued: number; cancelled: number; dueSoon: number; due: number; wouldRun: number; manualReview: number; errors: number };
const emptyOutcome = (): SweepOutcome => ({ opened: 0, rescued: 0, cancelled: 0, dueSoon: 0, due: 0, wouldRun: 0, manualReview: 0, errors: 0 });

const OPEN_STATUSES = ["open", "in_contact", "due_for_cancellation", "manual_review"] as const;
const OVERDUE_STATUSES = ["open", "overdue"] as const;

async function overdueUnpaid(tx: Tx, contractId: number, today: Date) {
  return tx.select({ id: installments.id, dueDate: installments.dueDate }).from(installments)
    .where(and(eq(installments.contractId, contractId), inArray(installments.status, [...OVERDUE_STATUSES]), lt(installments.dueDate, today)))
    .orderBy(installments.dueDate);
}

async function ceilingFacts(tx: Tx, contractId: number, caseId: number, settings: RetentionSettings, now: Date): Promise<CeilingFacts> {
  const [commission] = await tx.select({ id: salesCommissions.id }).from(salesCommissions).where(and(eq(salesCommissions.contractId, contractId), eq(salesCommissions.status, "paid"))).limit(1);
  const [renegotiation] = await tx.select({ id: installmentRenegotiations.id }).from(installmentRenegotiations)
    .where(and(eq(installmentRenegotiations.contractId, contractId), inArray(installmentRenegotiations.status, ["draft", "approved"]))).limit(1);
  const since = new Date(now.getTime() - settings.autoCancelPromiseDays * 86_400_000);
  const [promise] = settings.autoCancelPromiseDays > 0
    ? await tx.select({ id: contractRescueAttempts.id }).from(contractRescueAttempts).where(and(eq(contractRescueAttempts.caseId, caseId), inArray(contractRescueAttempts.outcome, ["promised_payment", "renegotiating"]), gt(contractRescueAttempts.createdAt, since))).limit(1)
    : [];
  const [totals] = await tx.select({ paid: sql<string>`COALESCE(SUM(${installments.paidAmount}), 0)`, contract: sql<string>`MAX(${contracts.totalAmount})` })
    .from(installments).innerJoin(contracts, eq(contracts.id, installments.contractId)).where(and(eq(installments.contractId, contractId), sql`${installments.status} <> 'cancelled'`));
  const total = Number(totals?.contract ?? 0);
  const paidPercent = total > 0 ? Math.round((Number(totals?.paid ?? 0) / total) * 10_000) / 100 : 0;
  return { hasPaidCommission: Boolean(commission), hasOpenRenegotiation: Boolean(renegotiation), recentPromise: Boolean(promise), paidPercent };
}

async function closeCase(tx: Tx, row: { id: number; contractId: number }, status: "rescued" | "cancelled" | "dismissed", now: Date, extra: { closedByUserId?: number | null; closeNote?: string | null; suppressUntil?: Date | null } = {}) {
  await tx.update(contractRescueCases).set({ status, activeKey: null, closedAt: now, closedByUserId: extra.closedByUserId ?? null, closeNote: extra.closeNote ?? null, suppressUntil: extra.suppressUntil ?? null }).where(eq(contractRescueCases.id, row.id));
  await txEvent(tx, { eventName: "contract.rescue.resolved", aggregateType: "contract_rescue_case", aggregateId: row.id, actorUserId: extra.closedByUserId ?? null, idempotencyKey: `rescue-resolved:${row.id}`, payload: { caseId: row.id, contractId: row.contractId, resolution: status } });
}

/** Ensaio do distrato automático para UM caso vencido: aplica os tetos e REGISTRA (revisão manual ou "teria rodado"). Nunca cancela nada. */
async function shadowDecide(tx: Tx, caseId: number, contractId: number, settings: CurrentRetentionSettings, now: Date, out: SweepOutcome) {
  const facts = await ceilingFacts(tx, contractId, caseId, settings, now);
  const blocked = evaluateCeilings(facts, settings);
  if (blocked) {
    await tx.update(contractRescueCases).set({ status: "manual_review", manualReviewReason: blocked, manualReviewAt: now }).where(eq(contractRescueCases.id, caseId));
    await txAudit(tx, { actorUserId: null, entityType: "contract_rescue_case", entityId: caseId, action: "shadow_manual_review", summary: `Modo sombra: o distrato automático NÃO seria feito (${blocked}); decisão humana.`, idempotencyKey: `audit:rescue-shadow-review:${caseId}` });
    out.manualReview++;
  } else {
    await txEvent(tx, { eventName: "contract.auto_cancellation.would_run", aggregateType: "contract_rescue_case", aggregateId: caseId, actorUserId: null, idempotencyKey: `auto-cancel-dry:${caseId}`, payload: { caseId, contractId, settingsVersionId: settings.versionId, paidPercent: facts.paidPercent } });
    await txAudit(tx, { actorUserId: null, entityType: "contract_rescue_case", entityId: caseId, action: "shadow_would_cancel", summary: "Modo sombra: o distrato automático TERIA sido pedido. Nada foi cancelado.", idempotencyKey: `audit:rescue-shadow-would:${caseId}` });
    out.wouldRun++;
  }
}

/** Um contrato por transação, travando na ordem do restante do CRM: contrato -> parcelas -> caso de resgate. Só escreve nas tabelas do resgate, em eventos e em auditoria. */
async function sweepContract(db: Db, contractId: number, settings: CurrentRetentionSettings, now: Date, out: SweepOutcome) {
  await withDeadlockRetry(() => db.transaction(async tx => {
    const [contract] = await tx.select({ id: contracts.id, status: contracts.status }).from(contracts).where(eq(contracts.id, contractId)).limit(1).for("update");
    if (!contract) return;
    const today = startOfUtcDay(now);
    const overdue = contract.status === "cancelled" || contract.status === "closed" ? [] : await overdueUnpaid(tx, contractId, today);
    const [open] = await tx.select().from(contractRescueCases).where(and(eq(contractRescueCases.contractId, contractId), inArray(contractRescueCases.status, [...OPEN_STATUSES]))).limit(1).for("update");

    if (!open) {
      if (!overdue.length) return;
      const firstOverdue = dateOnly(overdue[0]!.dueDate as unknown as Date | string);
      // Supressão após "dismissed": só reabre se passou o prazo OU existe parcela NOVA vencida depois do encerramento (fato novo).
      const [suppressing] = await tx.select().from(contractRescueCases).where(and(eq(contractRescueCases.contractId, contractId), eq(contractRescueCases.status, "dismissed"), gt(contractRescueCases.suppressUntil, now))).orderBy(desc(contractRescueCases.id)).limit(1);
      if (suppressing) {
        const closedDay = dateOnly(suppressing.closedAt ?? now);
        const hasNewOverdue = overdue.some(item => dateOnly(item.dueDate as unknown as Date | string) > closedDay);
        if (!hasNewOverdue) return;
      }
      const dueAt = rescueDueAtFor(firstOverdue, settings.rescueWindowMonths);
      const [{ id }] = await tx.insert(contractRescueCases).values({ contractId, reason: "overdue", status: "open", activeKey: `rescue:${contractId}`, firstOverdueDate: firstOverdue as unknown as Date, rescueDueAt: dueAt, settingsVersionId: settings.versionId }).$returningId();
      await txEvent(tx, { eventName: "contract.rescue.opened", aggregateType: "contract_rescue_case", aggregateId: id, actorUserId: null, idempotencyKey: `rescue-open:${id}`, payload: { caseId: Number(id), contractId, firstOverdueDate: firstOverdue, rescueDueAt: dueAt.toISOString() } });
      out.opened++;
      return;
    }

    const caseId = Number(open.id);
    if (contract.status === "cancelled") { await closeCase(tx, { id: caseId, contractId }, "cancelled", now); out.cancelled++; return; }
    if (!overdue.length) { await closeCase(tx, { id: caseId, contractId }, "rescued", now); out.rescued++; return; }

    const dueAt = new Date(open.rescueDueAt);
    if (open.status === "open" || open.status === "in_contact") {
      const alertFrom = new Date(dueAt.getTime() - settings.rescueAlertLeadDays * 86_400_000);
      if (now >= alertFrom && now < dueAt) {
        await txEvent(tx, { eventName: "contract.rescue.due_soon", aggregateType: "contract_rescue_case", aggregateId: caseId, actorUserId: null, idempotencyKey: `rescue-due-soon:${caseId}`, payload: { caseId, contractId, rescueDueAt: dueAt.toISOString() } });
        out.dueSoon++;
      }
      if (now >= dueAt) {
        await tx.update(contractRescueCases).set({ status: "due_for_cancellation" }).where(eq(contractRescueCases.id, caseId));
        out.due++;
        // Ensaio: só decide e REGISTRA o que o distrato automático faria (config vigente com liga/desliga LIGADO). Desligado: o caso fica "vencido" e o admin decide à mão.
        if (settings.autoCancelEnabled) await shadowDecide(tx, caseId, contractId, settings, now, out);
      }
    }
    // Caso que já estava vencido quando o admin ligou o ensaio: avalia agora (uma vez; o evento 'would_run' marca que já foi decidido).
    if (open.status === "due_for_cancellation" && settings.autoCancelEnabled && now >= dueAt) {
      const [decided] = await tx.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.idempotencyKey, `auto-cancel-dry:${caseId}`)).limit(1);
      if (!decided) await shadowDecide(tx, caseId, contractId, settings, now, out);
    }
  }));
}

/** Varredura periódica (modo sombra). Idempotente: reexecutar não duplica caso (activeKey único) nem evento (idempotencyKey). Falha em um contrato não derruba os outros. */
export async function runRescueSweep(db: Db, options: { now?: Date; limit?: number } = {}): Promise<SweepOutcome> {
  const now = options.now ?? new Date();
  const out = emptyOutcome();
  const settings = await currentRetentionSettings(db);
  const today = startOfUtcDay(now);
  // Contratos com caso ativo já entram por `openCases` (abaixo); aqui só os candidatos a abrir caso. Paginação por cursor (contractId crescente): nenhum contrato fica de fora por causa do teto da página.
  const pageSize = options.limit ?? 1000;
  const candidates: Array<{ id: number }> = [];
  for (let cursor = 0; ;) {
    const page = await db.selectDistinct({ id: installments.contractId }).from(installments).innerJoin(contracts, eq(contracts.id, installments.contractId))
      .where(and(inArray(installments.status, [...OVERDUE_STATUSES]), lt(installments.dueDate, today), inArray(contracts.status, ["active", "overdue"]), gt(installments.contractId, cursor),
        sql`NOT EXISTS (SELECT 1 FROM ${contractRescueCases} WHERE ${contractRescueCases.contractId} = ${installments.contractId} AND ${contractRescueCases.activeKey} IS NOT NULL)`))
      .orderBy(asc(installments.contractId)).limit(pageSize);
    candidates.push(...page);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1]!.id;
  }
  const openCases = await db.select({ contractId: contractRescueCases.contractId }).from(contractRescueCases).where(inArray(contractRescueCases.status, [...OPEN_STATUSES]));
  const ids = Array.from(new Set([...candidates.map(row => row.id), ...openCases.map(row => row.contractId)])).sort((a, b) => a - b);
  for (const contractId of ids) {
    try { await sweepContract(db, contractId, settings, now, out); } catch { out.errors++; }
  }
  return out;
}

export type RescueActionError = "NOT_FOUND" | "NOT_OPEN";

/** Tentativa do pós-vendas: registra, move open -> in_contact. Não toca contrato nem parcela. */
export async function recordRescueAttempt(db: Db, actorUserId: number, input: { caseId: number; channel: "phone" | "message" | "email" | "visit" | "other"; outcome: "no_answer" | "promised_payment" | "renegotiating" | "refused" | "other"; note?: string }, now = new Date()): Promise<{ ok: true; attemptId: number } | { ok: false; error: RescueActionError }> {
  return withDeadlockRetry(() => db.transaction(async tx => {
    const [row] = await tx.select().from(contractRescueCases).where(eq(contractRescueCases.id, input.caseId)).limit(1).for("update");
    if (!row) return { ok: false as const, error: "NOT_FOUND" as const };
    if (!(OPEN_STATUSES as readonly string[]).includes(row.status)) return { ok: false as const, error: "NOT_OPEN" as const };
    const [{ id }] = await tx.insert(contractRescueAttempts).values({ caseId: input.caseId, channel: input.channel, outcome: input.outcome, note: input.note?.trim() || null, createdByUserId: actorUserId }).$returningId();
    await tx.update(contractRescueCases).set({ lastAttemptAt: now, ...(row.status === "open" ? { status: "in_contact" as const } : {}) }).where(eq(contractRescueCases.id, input.caseId));
    await txEvent(tx, { eventName: "contract.rescue.attempted", aggregateType: "contract_rescue_case", aggregateId: input.caseId, actorUserId, idempotencyKey: `rescue-attempt:${id}`, payload: { caseId: input.caseId, contractId: row.contractId, attemptId: Number(id), outcome: input.outcome } });
    return { ok: true as const, attemptId: Number(id) };
  }));
}

/** Encerra sem resgate (pós-vendas/admin), com motivo. Suprime a reabertura pelo prazo `rescueReopenAfterDays` da configuração vigente. */
export async function dismissRescueCase(db: Db, actorUserId: number, input: { caseId: number; note: string }, now = new Date()): Promise<{ ok: true } | { ok: false; error: RescueActionError }> {
  const settings = await currentRetentionSettings(db);
  return withDeadlockRetry(() => db.transaction(async tx => {
    const [row] = await tx.select().from(contractRescueCases).where(eq(contractRescueCases.id, input.caseId)).limit(1).for("update");
    if (!row) return { ok: false as const, error: "NOT_FOUND" as const };
    if (!(OPEN_STATUSES as readonly string[]).includes(row.status)) return { ok: false as const, error: "NOT_OPEN" as const };
    await closeCase(tx, { id: input.caseId, contractId: row.contractId }, "dismissed", now, { closedByUserId: actorUserId, closeNote: input.note.trim(), suppressUntil: new Date(now.getTime() + settings.rescueReopenAfterDays * 86_400_000) });
    await txAudit(tx, { actorUserId, entityType: "contract_rescue_case", entityId: input.caseId, action: "dismissed", summary: `Caso de resgate encerrado sem resgate. Reabertura suprimida por ${settings.rescueReopenAfterDays} dia(s) salvo parcela nova vencida.` });
    return { ok: true as const };
  }));
}

export async function listRescueCases(db: Db, filter: { status?: "open_states" | "all"; limit?: number } = {}) {
  const where = filter.status === "all" ? undefined : inArray(contractRescueCases.status, [...OPEN_STATUSES]);
  return db.select({
    id: contractRescueCases.id, contractId: contractRescueCases.contractId, contractNumber: contracts.number, status: contractRescueCases.status, reason: contractRescueCases.reason,
    firstOverdueDate: contractRescueCases.firstOverdueDate, openedAt: contractRescueCases.openedAt, rescueDueAt: contractRescueCases.rescueDueAt, lastAttemptAt: contractRescueCases.lastAttemptAt,
    manualReviewReason: contractRescueCases.manualReviewReason, closedAt: contractRescueCases.closedAt, closeNote: contractRescueCases.closeNote,
  }).from(contractRescueCases).innerJoin(contracts, eq(contracts.id, contractRescueCases.contractId)).where(where).orderBy(contractRescueCases.rescueDueAt).limit(filter.limit ?? 200);
}

/** "Teria distratado" (ensaio): lê os eventos `would_run` e os casos em revisão manual de sombra, para a tela do admin. */
export async function listShadowDecisions(db: Db, limit = 100) {
  return db.select({ caseId: contractRescueCases.id, contractId: contractRescueCases.contractId, contractNumber: contracts.number, status: contractRescueCases.status, manualReviewReason: contractRescueCases.manualReviewReason, rescueDueAt: contractRescueCases.rescueDueAt,
    wouldRun: sql<number>`EXISTS (SELECT 1 FROM ${domainEvents} WHERE ${domainEvents.idempotencyKey} = CONCAT('auto-cancel-dry:', ${contractRescueCases.id}))` })
    .from(contractRescueCases).innerJoin(contracts, eq(contracts.id, contractRescueCases.contractId))
    .where(or(eq(contractRescueCases.status, "manual_review"), eq(contractRescueCases.status, "due_for_cancellation"))).orderBy(desc(contractRescueCases.rescueDueAt)).limit(limit);
}

export async function listRetentionHistory(db: Db, limit = 100) {
  return db.select().from(retentionSettingsVersions).orderBy(desc(retentionSettingsVersions.id)).limit(limit);
}

