import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ownershipEntitlements, pointsLedger, reservations } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, contractsProcedure, serviceProcedure } from "./access";
import { isDuplicateKeyError } from "../mysqlErrors";

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
 * mesmo requestId devolve o lançamento já gravado em vez de debitar de novo.
 */
const requestId = z.string().uuid();
async function existingRequest(tx: Tx, idempotencyKey: string) {
  const [row] = await tx.select({ id: pointsLedger.id }).from(pointsLedger).where(eq(pointsLedger.idempotencyKey, idempotencyKey)).limit(1);
  return row?.id;
}

/** Lançamentos mostrados no extrato; o saldo sempre sai da soma do extrato inteiro. */
export const STATEMENT_ENTRY_LIMIT = 500;

export const pointsLedgerRouter = router({
  statement: contractsProcedure.input(z.object({ entitlementId: z.number().int().positive() })).query(async ({ input }) => {
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
      const rows = await tx.select().from(pointsLedger).where(eq(pointsLedger.entitlementId, input.entitlementId)).orderBy(desc(pointsLedger.id)).limit(STATEMENT_ENTRY_LIMIT);
      const reversed = rows.length
        ? new Set((await tx.select({ reversesEntryId: pointsLedger.reversesEntryId }).from(pointsLedger).where(and(eq(pointsLedger.entitlementId, input.entitlementId), inArray(pointsLedger.reversesEntryId, rows.map(row => row.id))))).map(row => row.reversesEntryId))
        : new Set<number | null>();
      let after = balance;
      const entries = rows.map(row => { const entry = { id: row.id, entryType: row.entryType, points: row.points, balanceAfter: after, referenceYear: row.referenceYear, reservationId: row.reservationId, reversesEntryId: row.reversesEntryId, reversed: reversed.has(row.id), note: row.note, createdAt: row.createdAt }; after -= row.points; return entry; });
      return { entitlement: { id: entitlement.id, contractId: entitlement.contractId, entitlementType: entitlement.entitlementType, annualPoints: entitlement.annualPoints, status: entitlement.status }, balance, totalEntries, truncated: totalEntries > rows.length, entries };
    });
  }),

  creditAnnual: serviceProcedure.input(z.object({ entitlementId: z.number().int().positive(), year: z.number().int().min(2000).max(2100) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const id = await db.transaction(async tx => {
      const { entitlement } = await lockPointsEntitlement(tx, input.entitlementId);
      requireActive(entitlement);
      if (entitlement.annualPoints <= 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "O direito de uso não tem pontos anuais definidos." });
      const fromYear = entitlement.validFrom ? new Date(entitlement.validFrom).getUTCFullYear() : null;
      const untilYear = entitlement.validUntil ? new Date(entitlement.validUntil).getUTCFullYear() : null;
      if ((fromYear && input.year < fromYear) || (untilYear && input.year > untilYear)) throw new TRPCError({ code: "BAD_REQUEST", message: `O ano ${input.year} está fora da vigência do direito de uso.` });
      return append(tx, { entitlementId: entitlement.id, entryType: "annual_credit", points: entitlement.annualPoints, referenceYear: input.year, idempotencyKey: `annual:${entitlement.id}:${input.year}`, note: `Crédito anual ${input.year}`, createdByUserId: ctx.user.id }, `Os pontos de ${input.year} já foram creditados neste direito de uso.`);
    });
    await recordAudit(ctx.user.id, "points_ledger", id, "annual_credit", `Crédito anual ${input.year} no direito de uso ${input.entitlementId}.`);
    return { entryId: id };
  }),

  recordUsage: serviceProcedure.input(z.object({ entitlementId: z.number().int().positive(), points: z.number().int().positive().max(1_000_000), reservationId: z.number().int().positive().optional(), note: z.string().trim().max(255).optional(), requestId })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const idempotencyKey = `usage:${input.entitlementId}:${input.requestId}`;
    let replay = false;
    const id = await db.transaction(async tx => {
      const { entitlement, balance } = await lockPointsEntitlement(tx, input.entitlementId);
      const existing = await existingRequest(tx, idempotencyKey);
      if (existing) { replay = true; return existing; }
      requireActive(entitlement);
      if (input.reservationId) {
        const [reservation] = await tx.select({ contractId: reservations.contractId, status: reservations.status }).from(reservations).where(eq(reservations.id, input.reservationId)).limit(1);
        if (!reservation || reservation.contractId !== entitlement.contractId) throw new TRPCError({ code: "NOT_FOUND", message: "Reserva não encontrada para o contrato deste direito de uso." });
        if (reservation.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Reserva cancelada não consome pontos." });
        // Uma reserva consome pontos uma vez por direito; depois de estornado, o uso pode ser lançado de novo (a trava do direito põe em fila).
        const previous = await tx.select({ id: pointsLedger.id, reversesEntryId: pointsLedger.reversesEntryId, entryType: pointsLedger.entryType }).from(pointsLedger)
          .where(and(eq(pointsLedger.entitlementId, entitlement.id), eq(pointsLedger.reservationId, input.reservationId)));
        const reversedIds = new Set(previous.map(row => row.reversesEntryId).filter((id): id is number => id !== null));
        if (previous.some(row => row.entryType === "usage" && !reversedIds.has(row.id))) throw new TRPCError({ code: "CONFLICT", message: "Esta reserva já tem uso de pontos lançado neste direito. Para corrigir, estorne o lançamento." });
      }
      if (balance < input.points) throw insufficient(balance, input.points);
      return append(tx, { entitlementId: entitlement.id, entryType: "usage", points: -input.points, reservationId: input.reservationId ?? null, note: input.note || null, idempotencyKey, createdByUserId: ctx.user.id }, "Uso repetido.");
    });
    if (replay) return { entryId: id };
    await recordAudit(ctx.user.id, "points_ledger", id, "usage", `Uso de ${input.points} ponto(s) no direito de uso ${input.entitlementId}${input.reservationId ? ` (reserva ${input.reservationId})` : ""}.`);
    return { entryId: id };
  }),

  adjust: adminProcedure.input(z.object({ entitlementId: z.number().int().positive(), points: z.number().int().min(-1_000_000).max(1_000_000).refine(value => value !== 0, "Ajuste não pode ser zero."), note: z.string().trim().min(5, "Explique o ajuste.").max(255), requestId })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const idempotencyKey = `adjustment:${input.entitlementId}:${input.requestId}`;
    let replay = false;
    const id = await db.transaction(async tx => {
      const { entitlement, balance } = await lockPointsEntitlement(tx, input.entitlementId);
      const existing = await existingRequest(tx, idempotencyKey);
      if (existing) { replay = true; return existing; }
      requireActive(entitlement);
      if (balance + input.points < 0) throw insufficient(balance, -input.points);
      return append(tx, { entitlementId: entitlement.id, entryType: "adjustment", points: input.points, note: input.note, idempotencyKey, createdByUserId: ctx.user.id }, "Ajuste repetido.");
    });
    if (replay) return { entryId: id };
    await recordAudit(ctx.user.id, "points_ledger", id, "adjustment", `Ajuste de ${input.points} ponto(s) no direito de uso ${input.entitlementId}: ${input.note}.`);
    return { entryId: id };
  }),

  reverse: adminProcedure.input(z.object({ entryId: z.number().int().positive(), note: z.string().trim().min(5, "Explique o estorno.").max(255) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const result = await db.transaction(async tx => {
      const [target] = await tx.select().from(pointsLedger).where(eq(pointsLedger.id, input.entryId)).limit(1);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Lançamento não encontrado." });
      if (target.entryType === "reversal") throw new TRPCError({ code: "BAD_REQUEST", message: "Estorno não se estorna; faça um ajuste." });
      const { balance } = await lockPointsEntitlement(tx, target.entitlementId);
      if (balance - target.points < 0) throw insufficient(balance, target.points);
      const id = await append(tx, { entitlementId: target.entitlementId, entryType: "reversal", points: -target.points, referenceYear: target.referenceYear, reservationId: target.reservationId, reversesEntryId: target.id, idempotencyKey: `reversal:${target.id}`, note: input.note, createdByUserId: ctx.user.id }, "Este lançamento já foi estornado.");
      return { id, target };
    });
    await recordAudit(ctx.user.id, "points_ledger", result.id, "reversal", `Estorno do ${entryLabel[result.target.entryType]} ${result.target.id} (${result.target.points} ponto(s)): ${input.note}.`);
    return { entryId: result.id };
  }),
});
