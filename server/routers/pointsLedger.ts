import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { ownershipEntitlements, pointsLedger, reservations } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, contractsProcedure, serviceProcedure } from "./access";
import { isDuplicateKeyError } from "../mysqlErrors";
import { ENV } from "../_core/env";
import { localDateInTimezone } from "../saleTermsPolicy";

/**
 * Extrato de pontos do direito de uso (TSE #29). Só inclusão: crédito anual, uso, ajuste e estorno. Nenhum lançamento é
 * editado ou apagado. O saldo nunca fica negativo. Quantos pontos cada reserva custa é decisão de quem lança o uso: o
 * sistema não inventa tabela de preço em pontos.
 */
async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  return db;
}
type Db = Awaited<ReturnType<typeof requireDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const entryLabel = { annual_credit: "crédito anual", usage: "uso", adjustment: "ajuste", reversal: "estorno" } as const;

/**
 * Trava o direito de uso (fila por direito) e devolve o saldo atual. Só direito de pontos ativo recebe lançamento.
 * A soma é leitura com trava (current read): se a transação já tinha um snapshot de antes de esperar a trava (o estorno lê
 * o lançamento alvo primeiro), uma soma comum ignoraria o uso que a transação da frente acabou de gravar.
 */
async function lockPointsEntitlement(tx: Tx, entitlementId: number) {
  const [entitlement] = await tx.select().from(ownershipEntitlements).where(eq(ownershipEntitlements.id, entitlementId)).limit(1).for("update");
  if (!entitlement) throw new TRPCError({ code: "NOT_FOUND", message: "Direito de uso não encontrado." });
  if (entitlement.entitlementType !== "points") throw new TRPCError({ code: "BAD_REQUEST", message: "Este direito de uso não é por pontos." });
  const [{ balance }] = await tx.select({ balance: sql<number>`coalesce(sum(${pointsLedger.points}), 0)` }).from(pointsLedger).where(eq(pointsLedger.entitlementId, entitlementId)).for("share");
  return { entitlement, balance: Number(balance) };
}
const requireActive = (entitlement: { status: string }) => {
  if (entitlement.status !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Direito de uso não está ativo." });
};
const dateKey = (value: Date | string | null) => value ? new Date(value).toISOString().slice(0, 10) : null;
/**
 * Uso e ajuste só dentro da vigência, pelo dia do projeto: nenhum processo muda o status para "vencido" quando a data
 * passa, então a data é conferida aqui.
 */
const requireInValidity = (entitlement: { validFrom: Date | null; validUntil: Date | null }) => {
  const today = localDateInTimezone(new Date(), ENV.financialProjectTimezone.trim() || "America/Recife");
  const from = dateKey(entitlement.validFrom);
  const until = dateKey(entitlement.validUntil);
  if (from && today < from) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `O direito de uso só vale a partir de ${from}.` });
  if (until && today > until) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `O direito de uso venceu em ${until}.` });
};
const insufficient = (balance: number, points: number) => new TRPCError({ code: "PRECONDITION_FAILED", message: `Saldo insuficiente: ${balance} ponto(s) disponível(is), lançamento de ${points}.` });

async function append(tx: Tx, values: typeof pointsLedger.$inferInsert, duplicateMessage: string) {
  try {
    const [created] = await tx.insert(pointsLedger).values(values).$returningId();
    return created.id;
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new TRPCError({ code: "CONFLICT", message: duplicateMessage });
    throw error;
  }
}

/**
 * Uso e ajuste manuais trazem um requestId gerado pela tela a cada lançamento. Se a resposta se perde e a tela reenvia, o
 * mesmo requestId devolve o lançamento já gravado em vez de debitar de novo. A auditoria tem chave pelo lançamento: o
 * reenvio grava a que faltou (se a primeira falhou) e nunca duplica.
 */
const requestId = z.string().uuid();
async function existingRequest(tx: Tx, idempotencyKey: string) {
  const [row] = await tx.select().from(pointsLedger).where(eq(pointsLedger.idempotencyKey, idempotencyKey)).limit(1);
  return row;
}
type LedgerRow = typeof pointsLedger.$inferSelect;
const reusedRequest = () => new TRPCError({ code: "CONFLICT", message: "Este pedido já foi gravado com outros dados. Recarregue o extrato antes de lançar de novo." });
const usageAudit = (row: LedgerRow) => `Uso de ${-row.points} ponto(s) no direito de uso ${row.entitlementId}${row.reservationId ? ` (reserva ${row.reservationId})` : ""}.`;
const adjustmentAudit = (row: LedgerRow) => `Ajuste de ${row.points} ponto(s) no direito de uso ${row.entitlementId}: ${row.note ?? ""}.`;

/** Lançamentos mostrados no extrato; o saldo sempre sai da soma do extrato inteiro. */
export const STATEMENT_ENTRY_LIMIT = 500;

export const pointsLedgerRouter = router({
  // Página do extrato: sem beforeId, os mais recentes; com beforeId, os anteriores a ele. nextBeforeId abre a página
  // seguinte, para que todo lançamento antigo possa ser visto e estornado.
  statement: contractsProcedure.input(z.object({ entitlementId: z.number().int().positive(), beforeId: z.number().int().positive().optional() })).query(async ({ input }) => {
    const db = await requireDb();
    const [entitlement] = await db.select().from(ownershipEntitlements).where(eq(ownershipEntitlements.id, input.entitlementId)).limit(1);
    if (!entitlement) throw new TRPCError({ code: "NOT_FOUND", message: "Direito de uso não encontrado." });
    // Saldo e total pela soma do extrato inteiro; a lista traz os lançamentos mais recentes, com o saldo de cada um
    // calculado de trás para frente a partir do saldo total.
    // Todas as leituras no mesmo snapshot: saldo, lista e estornos descrevem o mesmo momento do extrato.
    return db.transaction(async tx => {
      const [totals] = await tx.select({ balance: sql<number>`coalesce(sum(${pointsLedger.points}), 0)`, count: sql<number>`count(*)` }).from(pointsLedger).where(eq(pointsLedger.entitlementId, input.entitlementId));
      const balance = Number(totals?.balance ?? 0);
      const totalEntries = Number(totals?.count ?? 0);
      const pageFilter = input.beforeId ? and(eq(pointsLedger.entitlementId, input.entitlementId), lt(pointsLedger.id, input.beforeId)) : eq(pointsLedger.entitlementId, input.entitlementId);
      const rows = await tx.select().from(pointsLedger).where(pageFilter).orderBy(desc(pointsLedger.id)).limit(STATEMENT_ENTRY_LIMIT + 1);
      const hasMore = rows.length > STATEMENT_ENTRY_LIMIT;
      if (hasMore) rows.pop();
      // Saldo depois do lançamento mais novo da página: o total, ou a soma de tudo antes do cursor.
      const pageTop = input.beforeId
        ? Number((await tx.select({ value: sql<number>`coalesce(sum(${pointsLedger.points}), 0)` }).from(pointsLedger).where(pageFilter))[0]?.value ?? 0)
        : balance;
      const reversed = rows.length
        ? new Set((await tx.select({ reversesEntryId: pointsLedger.reversesEntryId }).from(pointsLedger).where(and(eq(pointsLedger.entitlementId, input.entitlementId), inArray(pointsLedger.reversesEntryId, rows.map(row => row.id))))).map(row => row.reversesEntryId))
        : new Set<number | null>();
      let after = pageTop;
      const entries = rows.map(row => { const entry = { id: row.id, entryType: row.entryType, points: row.points, balanceAfter: after, referenceYear: row.referenceYear, reservationId: row.reservationId, reversesEntryId: row.reversesEntryId, reversed: reversed.has(row.id), note: row.note, createdAt: row.createdAt }; after -= row.points; return entry; });
      return { entitlement: { id: entitlement.id, contractId: entitlement.contractId, entitlementType: entitlement.entitlementType, annualPoints: entitlement.annualPoints, status: entitlement.status }, balance, totalEntries, truncated: hasMore || Boolean(input.beforeId), nextBeforeId: hasMore ? rows[rows.length - 1]!.id : null, entries };
    });
  }),

  creditAnnual: serviceProcedure.input(z.object({ entitlementId: z.number().int().positive(), year: z.number().int().min(2000).max(2100) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const idempotencyKey = `annual:${input.entitlementId}:${input.year}`;
    let duplicate = false;
    const id = await db.transaction(async tx => {
      const { entitlement } = await lockPointsEntitlement(tx, input.entitlementId);
      // Ano já creditado: responde CONFLICT, mas antes grava a auditoria do crédito se ela tiver faltado.
      const existing = await existingRequest(tx, idempotencyKey);
      if (existing) { duplicate = true; return existing.id; }
      requireActive(entitlement);
      if (entitlement.annualPoints <= 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "O direito de uso não tem pontos anuais definidos." });
      const fromYear = entitlement.validFrom ? new Date(entitlement.validFrom).getUTCFullYear() : null;
      const untilYear = entitlement.validUntil ? new Date(entitlement.validUntil).getUTCFullYear() : null;
      if ((fromYear && input.year < fromYear) || (untilYear && input.year > untilYear)) throw new TRPCError({ code: "BAD_REQUEST", message: `O ano ${input.year} está fora da vigência do direito de uso.` });
      // Ano futuro não se credita antes da hora: o saldo é uma soma só, e pontos de anos à frente já poderiam ser usados hoje.
      const currentYear = Number(localDateInTimezone(new Date(), ENV.financialProjectTimezone.trim() || "America/Recife").slice(0, 4));
      if (input.year > currentYear) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Os pontos de ${input.year} só podem ser creditados a partir de ${input.year}.` });
      return append(tx, { entitlementId: entitlement.id, entryType: "annual_credit", points: entitlement.annualPoints, referenceYear: input.year, idempotencyKey, note: `Crédito anual ${input.year}`, createdByUserId: ctx.user.id }, `Os pontos de ${input.year} já foram creditados neste direito de uso.`);
    });
    await recordAudit(ctx.user.id, "points_ledger", id, "annual_credit", `Crédito anual ${input.year} no direito de uso ${input.entitlementId}.`, { idempotencyKey: `points_ledger:${id}` });
    if (duplicate) throw new TRPCError({ code: "CONFLICT", message: `Os pontos de ${input.year} já foram creditados neste direito de uso.` });
    return { entryId: id };
  }),

  recordUsage: serviceProcedure.input(z.object({ entitlementId: z.number().int().positive(), points: z.number().int().positive().max(1_000_000), reservationId: z.number().int().positive().optional(), note: z.string().trim().max(255).optional(), requestId })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const idempotencyKey = `usage:${input.entitlementId}:${input.requestId}`;
    const entry = await db.transaction(async tx => {
      const { entitlement, balance } = await lockPointsEntitlement(tx, input.entitlementId);
      const existing = await existingRequest(tx, idempotencyKey);
      if (existing) return { row: existing, mismatch: existing.points !== -input.points || existing.reservationId !== (input.reservationId ?? null) || existing.note !== (input.note || null) };
      requireActive(entitlement);
      requireInValidity(entitlement);
      if (input.reservationId) {
        // Trava a reserva: o cancelamento dela trava a mesma linha e confere os pontos lançados, então uso e cancelamento entram em fila.
        const [reservation] = await tx.select({ contractId: reservations.contractId, status: reservations.status }).from(reservations).where(eq(reservations.id, input.reservationId)).limit(1).for("update");
        if (!reservation || reservation.contractId !== entitlement.contractId) throw new TRPCError({ code: "NOT_FOUND", message: "Reserva não encontrada para o contrato deste direito de uso." });
        if (reservation.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Reserva cancelada não consome pontos." });
        // Uma reserva consome pontos uma vez por direito; depois de estornado, o uso pode ser lançado de novo (a trava do direito põe em fila).
        const previous = await tx.select({ id: pointsLedger.id, reversesEntryId: pointsLedger.reversesEntryId, entryType: pointsLedger.entryType }).from(pointsLedger)
          .where(and(eq(pointsLedger.entitlementId, entitlement.id), eq(pointsLedger.reservationId, input.reservationId)));
        const reversedIds = new Set(previous.map(row => row.reversesEntryId).filter((id): id is number => id !== null));
        if (previous.some(row => row.entryType === "usage" && !reversedIds.has(row.id))) throw new TRPCError({ code: "CONFLICT", message: "Esta reserva já tem uso de pontos lançado neste direito. Para corrigir, estorne o lançamento." });
      }
      if (balance < input.points) throw insufficient(balance, input.points);
      const id = await append(tx, { entitlementId: entitlement.id, entryType: "usage", points: -input.points, reservationId: input.reservationId ?? null, note: input.note || null, idempotencyKey, createdByUserId: ctx.user.id }, "Uso repetido.");
      const [row] = await tx.select().from(pointsLedger).where(eq(pointsLedger.id, id)).limit(1);
      return { row: row!, mismatch: false };
    });
    // A auditoria sai do lançamento gravado, nunca do pedido: no reenvio, ela descreve o que de fato está no extrato.
    await recordAudit(entry.row.createdByUserId, "points_ledger", entry.row.id, "usage", usageAudit(entry.row), { idempotencyKey: `points_ledger:${entry.row.id}` });
    if (entry.mismatch) throw reusedRequest();
    return { entryId: entry.row.id };
  }),

  adjust: adminProcedure.input(z.object({ entitlementId: z.number().int().positive(), points: z.number().int().min(-1_000_000).max(1_000_000).refine(value => value !== 0, "Ajuste não pode ser zero."), note: z.string().trim().min(5, "Explique o ajuste.").max(255), requestId })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const idempotencyKey = `adjustment:${input.entitlementId}:${input.requestId}`;
    const entry = await db.transaction(async tx => {
      const { entitlement, balance } = await lockPointsEntitlement(tx, input.entitlementId);
      const existing = await existingRequest(tx, idempotencyKey);
      if (existing) return { row: existing, mismatch: existing.points !== input.points || existing.note !== input.note };
      requireActive(entitlement);
      requireInValidity(entitlement);
      if (balance + input.points < 0) throw insufficient(balance, -input.points);
      const id = await append(tx, { entitlementId: entitlement.id, entryType: "adjustment", points: input.points, note: input.note, idempotencyKey, createdByUserId: ctx.user.id }, "Ajuste repetido.");
      const [row] = await tx.select().from(pointsLedger).where(eq(pointsLedger.id, id)).limit(1);
      return { row: row!, mismatch: false };
    });
    await recordAudit(entry.row.createdByUserId, "points_ledger", entry.row.id, "adjustment", adjustmentAudit(entry.row), { idempotencyKey: `points_ledger:${entry.row.id}` });
    if (entry.mismatch) throw reusedRequest();
    return { entryId: entry.row.id };
  }),

  reverse: adminProcedure.input(z.object({ entryId: z.number().int().positive(), note: z.string().trim().min(5, "Explique o estorno.").max(255) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const result = await db.transaction(async tx => {
      const [target] = await tx.select().from(pointsLedger).where(eq(pointsLedger.id, input.entryId)).limit(1);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Lançamento não encontrado." });
      if (target.entryType === "reversal") throw new TRPCError({ code: "BAD_REQUEST", message: "Estorno não se estorna; faça um ajuste." });
      const { balance } = await lockPointsEntitlement(tx, target.entitlementId);
      // Já estornado: responde CONFLICT, mas antes grava a auditoria do estorno se ela tiver faltado.
      const existing = await existingRequest(tx, `reversal:${target.id}`);
      if (existing) return { id: existing.id, target, note: existing.note ?? "", userId: existing.createdByUserId, duplicate: true };
      if (balance - target.points < 0) throw insufficient(balance, target.points);
      const id = await append(tx, { entitlementId: target.entitlementId, entryType: "reversal", points: -target.points, referenceYear: target.referenceYear, reservationId: target.reservationId, reversesEntryId: target.id, idempotencyKey: `reversal:${target.id}`, note: input.note, createdByUserId: ctx.user.id }, "Este lançamento já foi estornado.");
      return { id, target, note: input.note, userId: ctx.user.id, duplicate: false };
    });
    await recordAudit(result.userId, "points_ledger", result.id, "reversal", `Estorno do ${entryLabel[result.target.entryType]} ${result.target.id} (${result.target.points} ponto(s)): ${result.note}.`, { idempotencyKey: `points_ledger:${result.id}` });
    if (result.duplicate) throw new TRPCError({ code: "CONFLICT", message: "Este lançamento já foi estornado." });
    return { entryId: result.id };
  }),
});
