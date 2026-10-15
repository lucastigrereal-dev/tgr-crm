import { randomInt } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, isNull, lt, not, or, sql } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, customers, vouchers } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { internalProcedure, receptionProcedure, salesProcedure } from "./access";
import { isDuplicateKeyError } from "../mysqlErrors";
import { localDateInTimezone } from "../saleTermsPolicy";

/**
 * Voucher/brinde (TSE #31): emitir com custo e validade, dar baixa quando o casal usa, cancelar com motivo.
 * A validade vale até o fim do dia no fuso do projeto; vencido não é gravado, é calculado na leitura.
 */
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 8 }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join("");
const projectTimezone = () => ENV.financialProjectTimezone.trim() || "America/Recife";
const projectToday = () => localDateInTimezone(new Date(), projectTimezone());
const normalizeCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

type VoucherRow = typeof vouchers.$inferSelect;
export type VoucherState = "issued" | "redeemed" | "cancelled" | "expired";
export function voucherState(row: Pick<VoucherRow, "status" | "expiresAt">, today: string): VoucherState {
  if (row.status !== "issued") return row.status;
  return row.expiresAt && row.expiresAt < today ? "expired" : "issued";
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  return db;
}

const money = z.number().min(0).max(999999.99);
export const SUMMARY_PAGE_SIZE = 5000;
export const CUSTOMER_LIST_LIMIT = 200;
export const CAPTURE_PAGE_SIZE = 50;

/** Auditoria idempotente da baixa ou do cancelamento, gravada com os dados do próprio voucher. */
async function auditTerminal(row: VoucherRow) {
  if (row.status === "redeemed") await recordAudit(row.redeemedByUserId, "voucher", row.id, "redeemed", `Voucher ${row.code} usado pelo associado ${row.customerId}.`, { idempotencyKey: `voucher_redeemed:${row.id}` });
  if (row.status === "cancelled") await recordAudit(row.cancelledByUserId, "voucher", row.id, "cancelled", `Voucher ${row.code} cancelado: ${row.cancelReason ?? ""}.`, { idempotencyKey: `voucher_cancelled:${row.id}` });
}

export const vouchersRouter = router({
  // Todos os válidos (sem baixa, sem cancelamento e dentro da validade no dia do projeto) vêm sempre, sem limite, para
  // poderem ser usados ou cancelados pela ficha; o histórico (usados, cancelados, vencidos) traz os mais recentes e avisa o corte.
  listByCustomer: internalProcedure.input(z.object({ customerId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await requireDb();
    const today = projectToday();
    const valid = and(eq(vouchers.status, "issued"), or(isNull(vouchers.expiresAt), gte(vouchers.expiresAt, today)));
    // Válidos, histórico e contagem no mesmo snapshot: um voucher baixado entre as leituras não aparece duas vezes.
    return db.transaction(async tx => {
      const validRows = await tx.select().from(vouchers).where(and(eq(vouchers.customerId, input.customerId), valid)).orderBy(desc(vouchers.issuedAt), desc(vouchers.id));
      const historyFilter = and(eq(vouchers.customerId, input.customerId), not(valid!));
      const historyRows = await tx.select().from(vouchers).where(historyFilter).orderBy(desc(vouchers.issuedAt), desc(vouchers.id)).limit(CUSTOMER_LIST_LIMIT + 1);
      const historyTruncated = historyRows.length > CUSTOMER_LIST_LIMIT;
      if (historyTruncated) historyRows.pop();
      const historyTotal = historyTruncated ? Number((await tx.select({ count: sql<number>`count(*)` }).from(vouchers).where(historyFilter))[0]?.count ?? 0) : historyRows.length;
      const total = validRows.length + historyTotal;
      const list = [...validRows, ...historyRows].map(row => ({ id: row.id, code: row.code, captureId: row.captureId, description: row.description, costAmount: Number(row.costAmount), expiresAt: row.expiresAt, state: voucherState(row, today), issuedAt: row.issuedAt, redeemedAt: row.redeemedAt, redeemNote: row.redeemNote, cancelledAt: row.cancelledAt, cancelReason: row.cancelReason }));
      return { vouchers: list, total, validCount: validRows.length, truncated: historyTruncated };
    });
  }),

  /** Fichas de captação do associado, para ligar o brinde ao tour/venda que o originou. */
  // Em páginas, da mais nova para a mais antiga: com beforeId, as anteriores a ela. nextBeforeId abre a página seguinte,
  // para que qualquer ficha antiga possa ser escolhida.
  captureOptions: internalProcedure.input(z.object({ customerId: z.number().int().positive(), beforeId: z.number().int().positive().optional() })).query(async ({ input }) => {
    const db = await requireDb();
    const filter = input.beforeId ? and(eq(captureRecords.customerId, input.customerId), lt(captureRecords.id, input.beforeId)) : eq(captureRecords.customerId, input.customerId);
    const rows = await db.select({ id: captureRecords.id, createdAt: captureRecords.createdAt, scheduledAt: captureRecords.scheduledAt, captureLocation: captureRecords.captureLocation, presentationStatus: captureRecords.presentationStatus })
      .from(captureRecords).where(filter).orderBy(desc(captureRecords.id)).limit(CAPTURE_PAGE_SIZE + 1);
    const hasMore = rows.length > CAPTURE_PAGE_SIZE;
    if (hasMore) rows.pop();
    return { captures: rows, nextBeforeId: hasMore ? rows[rows.length - 1]!.id : null };
  }),

  /** Custo dos brindes emitidos no período, por situação: quanto foi prometido, usado, cancelado e perdido por validade. */
  // Sem datas, o período é do dia 1º do mês até hoje, no fuso do projeto; a resposta devolve o período usado.
  summary: internalProcedure.input(z.object({ startDate: z.string().date().optional(), endDate: z.string().date().optional() }).default({})).query(async ({ input }) => {
    const today = projectToday();
    const endDate = input.endDate ?? today;
    const startDate = input.startDate ?? `${endDate.slice(0, 7)}-01`;
    if (endDate < startDate) throw new TRPCError({ code: "BAD_REQUEST", message: "A data final vem antes da inicial." });
    const db = await requireDb();
    // Busca com um dia de folga em cada ponta e filtra pela data de emissão no fuso do projeto. Lê o período inteiro em
    // páginas pelo id, sem corte: o resumo é de dinheiro e não pode sair menor do que é.
    const from = new Date(`${startDate}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(`${endDate}T00:00:00Z`); to.setUTCDate(to.getUTCDate() + 2);
    const timezone = projectTimezone();
    const totals = { issued: { count: 0, cents: 0 }, redeemed: { count: 0, cents: 0 }, cancelled: { count: 0, cents: 0 }, expired: { count: 0, cents: 0 } };
    // Cursor por (data de emissão, id), na ordem do índice vouchers_issued_idx: cada página lê só o trecho do período.
    let cursor: { at: Date; id: number } | null = null;
    for (;;) {
      const range = and(gte(vouchers.issuedAt, from), lt(vouchers.issuedAt, to));
      const after = cursor ? or(gt(vouchers.issuedAt, cursor.at), and(eq(vouchers.issuedAt, cursor.at), gt(vouchers.id, cursor.id))) : undefined;
      const page = await db.select({ id: vouchers.id, status: vouchers.status, expiresAt: vouchers.expiresAt, costAmount: vouchers.costAmount, issuedAt: vouchers.issuedAt }).from(vouchers)
        .where(after ? and(range, after) : range).orderBy(asc(vouchers.issuedAt), asc(vouchers.id)).limit(SUMMARY_PAGE_SIZE);
      for (const row of page) {
        const day = localDateInTimezone(row.issuedAt, timezone);
        if (day < startDate || day > endDate) continue;
        const bucket = totals[voucherState(row, today)];
        bucket.count += 1;
        bucket.cents += Math.round(Number(row.costAmount) * 100);
      }
      if (page.length < SUMMARY_PAGE_SIZE) break;
      const last: { issuedAt: Date; id: number } = page[page.length - 1]!;
      cursor = { at: last.issuedAt, id: last.id };
    }
    const out = (bucket: { count: number; cents: number }) => ({ count: bucket.count, cost: bucket.cents / 100 });
    const all = Object.values(totals).reduce((sum, bucket) => ({ count: sum.count + bucket.count, cents: sum.cents + bucket.cents }), { count: 0, cents: 0 });
    return { startDate, endDate, issued: out(totals.issued), redeemed: out(totals.redeemed), cancelled: out(totals.cancelled), expired: out(totals.expired), total: out(all) };
  }),

  issue: receptionProcedure.input(z.object({ customerId: z.number().int().positive(), captureId: z.number().int().positive().optional(), description: z.string().trim().min(3, "Descreva o brinde.").max(255), costAmount: money.default(0), expiresAt: z.string().date().optional(), requestId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const [customer] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Associado não encontrado." });
    if (input.captureId) {
      const [capture] = await db.select({ customerId: captureRecords.customerId }).from(captureRecords).where(eq(captureRecords.id, input.captureId)).limit(1);
      if (!capture || capture.customerId !== input.customerId) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada para este associado." });
    }
    const auditIssued = (actorUserId: number | null, id: number, code: string, customerId: number, description: string) =>
      recordAudit(actorUserId, "voucher", id, "issued", `Voucher ${code} emitido para o associado ${customerId}: ${description}.`, { idempotencyKey: `voucher_issued:${id}` });
    // Reenvio da mesma emissão (resposta perdida, auditoria que falhou): devolve o voucher já gravado, sem novo código.
    const previous = async () => {
      const [row] = await db.select().from(vouchers).where(eq(vouchers.requestId, input.requestId)).limit(1);
      if (!row) return undefined;
      if (row.customerId !== input.customerId) throw new TRPCError({ code: "CONFLICT", message: "Esta emissão já foi usada para outro associado." });
      // Se a auditoria da primeira tentativa falhou, o reenvio a grava; se já existe, a chave impede a duplicata.
      await auditIssued(row.issuedByUserId, row.id, row.code, row.customerId, row.description);
      // Reenvio com o brinde editado na tela: não finge que emitiu o que foi digitado agora.
      const changed = row.description !== input.description || Math.round(Number(row.costAmount) * 100) !== Math.round(input.costAmount * 100) || (row.expiresAt ?? null) !== (input.expiresAt ?? null) || (row.captureId ?? null) !== (input.captureId ?? null);
      if (changed) throw new TRPCError({ code: "CONFLICT", message: `Esta emissão já gerou o voucher ${row.code} com outros dados. Confira a lista antes de emitir de novo.` });
      return { voucherId: row.id, code: row.code };
    };
    const replay = await previous();
    if (replay) return replay;
    // A validade no passado só barra emissão nova: o reenvio de uma emissão feita no último dia, depois da meia-noite, devolve o voucher.
    if (input.expiresAt && input.expiresAt < projectToday()) throw new TRPCError({ code: "BAD_REQUEST", message: "A validade não pode ser no passado." });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newCode();
      try {
        const [created] = await db.insert(vouchers).values({ code, customerId: input.customerId, captureId: input.captureId ?? null, description: input.description, costAmount: input.costAmount.toFixed(2), expiresAt: input.expiresAt ?? null, issuedByUserId: ctx.user.id, requestId: input.requestId }).$returningId();
        await auditIssued(ctx.user.id, created.id, code, input.customerId, input.description);
        return { voucherId: created.id, code };
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        // Dois envios da mesma emissão ao mesmo tempo: o que perdeu devolve o do que ganhou.
        const raced = await previous();
        if (raced) return raced;
      }
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível gerar um código de voucher. Tente de novo." });
  }),

  redeem: receptionProcedure.input(z.object({ code: z.string().trim().min(4).max(32), note: z.string().trim().max(255).optional() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const code = normalizeCode(input.code);
    const { row: voucher, refusal } = await db.transaction(async tx => {
      const [row] = await tx.select().from(vouchers).where(eq(vouchers.code, code)).limit(1).for("update");
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Voucher não encontrado. Confira o código." });
      const state = voucherState(row, projectToday());
      if (state === "redeemed") return { row, refusal: new TRPCError({ code: "CONFLICT", message: "Este voucher já foi usado." }) };
      if (state === "cancelled") return { row, refusal: new TRPCError({ code: "PRECONDITION_FAILED", message: "Este voucher foi cancelado." }) };
      if (state === "expired") return { row, refusal: new TRPCError({ code: "PRECONDITION_FAILED", message: `Este voucher venceu em ${row.expiresAt}.` }) };
      const redeemedAt = new Date();
      await tx.update(vouchers).set({ status: "redeemed", redeemedAt, redeemedByUserId: ctx.user.id, redeemNote: input.note || null }).where(and(eq(vouchers.id, row.id), eq(vouchers.status, "issued")));
      return { row: { ...row, status: "redeemed" as const, redeemedByUserId: ctx.user.id }, refusal: null };
    });
    // A auditoria da baixa (ou do cancelamento) tem chave pelo voucher: se ela falhou na primeira vez, a próxima tentativa
    // sobre o mesmo voucher a grava antes de responder que ele já foi usado.
    await auditTerminal(voucher);
    if (refusal) throw refusal;
    return { voucherId: voucher.id, customerId: voucher.customerId, description: voucher.description };
  }),

  cancel: salesProcedure.input(z.object({ id: z.number().int().positive(), reason: z.string().trim().min(5, "Informe o motivo do cancelamento.").max(255) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const { row: voucher, refusal } = await db.transaction(async tx => {
      const [row] = await tx.select().from(vouchers).where(eq(vouchers.id, input.id)).limit(1).for("update");
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Voucher não encontrado." });
      if (row.status !== "issued") return { row, refusal: new TRPCError({ code: "CONFLICT", message: row.status === "redeemed" ? "Voucher já usado não pode ser cancelado." : "Voucher já cancelado." }) };
      // Vencido fica vencido: cancelar depois da validade mudaria o histórico (e o custo) de "vencido sem uso" para "cancelado".
      if (voucherState(row, projectToday()) === "expired") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Este voucher venceu em ${row.expiresAt}; não há o que cancelar.` });
      await tx.update(vouchers).set({ status: "cancelled", cancelledAt: new Date(), cancelledByUserId: ctx.user.id, cancelReason: input.reason }).where(eq(vouchers.id, row.id));
      return { row: { ...row, status: "cancelled" as const, cancelledByUserId: ctx.user.id, cancelReason: input.reason }, refusal: null };
    });
    await auditTerminal(voucher);
    if (refusal) throw refusal;
    return { success: true };
  }),
});

