import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { billingRecords, contracts, customers, financialTransactions, financialTransfers, installments } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { financeProcedure } from "./access";

const dateValue = (value: string) => new Date(`${value}T12:00:00Z`);

export const financeRouter = router({
  installments: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ installment: installments, contractNumber: contracts.number, customerName: customers.fullName })
      .from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id))
      .orderBy(desc(installments.dueDate)).limit(300);
  }),

  billing: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ billing: billingRecords, installmentSequence: installments.sequence, contractNumber: contracts.number, customerName: customers.fullName })
      .from(billingRecords).innerJoin(installments, eq(billingRecords.installmentId, installments.id)).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id))
      .orderBy(desc(billingRecords.createdAt)).limit(300);
  }),

  registerBilling: financeProcedure.input(z.object({ installmentId: z.number().int().positive(), type: z.enum(["boleto", "pix", "card", "transfer"]), amount: z.coerce.number().positive(), dueDate: z.string().date(), externalReference: z.string().trim().max(255).optional().nullable(), digitableLine: z.string().trim().max(255).optional().nullable(), pixCopyPaste: z.string().trim().max(4000).optional().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const created = await db.insert(billingRecords).values({ ...input, amount: input.amount.toFixed(2), dueDate: dateValue(input.dueDate), externalReference: input.externalReference || `TSE-${input.installmentId}-${Date.now()}`, digitableLine: input.digitableLine || null, pixCopyPaste: input.pixCopyPaste || null, status: "generated", generatedAt: new Date() }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar a cobrança." });
      await recordAudit(ctx.user.id, "billing_record", id, "registered", `Cobrança ${input.type} registrada.`);
      return { id };
    }),

  markInstallmentPaid: financeProcedure.input(z.object({ id: z.number().int().positive(), paymentMethod: z.string().trim().max(64).optional().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const item = (await db.select().from(installments).where(eq(installments.id, input.id)).limit(1))[0];
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
      await db.transaction(async tx => {
        await tx.update(installments).set({ status: "paid", paidAt: new Date(), paymentMethod: input.paymentMethod || null }).where(eq(installments.id, input.id));
        await tx.update(billingRecords).set({ status: "paid" }).where(eq(billingRecords.installmentId, input.id));
        await tx.insert(financialTransactions).values({ contractId: item.contractId, type: "income", category: "Parcela de contrato", description: `Baixa da parcela ${item.sequence}`, amount: item.amount, dueDate: item.dueDate, paidAt: new Date(), status: "paid", createdByUserId: ctx.user.id });
      });
      await recordAudit(ctx.user.id, "installment", input.id, "paid", `Parcela ${item.sequence} baixada como paga.`);
      await recordDomainEvent({ eventName: "installment.paid", aggregateType: "installment", aggregateId: input.id, actorUserId: ctx.user.id, payload: { contractId: item.contractId, sequence: item.sequence, amount: item.amount } });
      return { success: true };
    }),

  entries: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ entry: financialTransactions, contractNumber: contracts.number }).from(financialTransactions).leftJoin(contracts, eq(financialTransactions.contractId, contracts.id)).orderBy(desc(financialTransactions.createdAt)).limit(300);
  }),

  createEntry: financeProcedure.input(z.object({ contractId: z.number().int().positive().optional().nullable(), type: z.enum(["income", "expense"]), category: z.string().trim().min(2).max(120), description: z.string().trim().min(2).max(2000), amount: z.coerce.number().positive(), dueDate: z.string().date().optional().nullable(), status: z.enum(["open", "paid"]).default("open") }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const created = await db.insert(financialTransactions).values({ ...input, contractId: input.contractId ?? null, amount: input.amount.toFixed(2), dueDate: input.dueDate ? dateValue(input.dueDate) : null, paidAt: input.status === "paid" ? new Date() : null, createdByUserId: ctx.user.id }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o lançamento." });
      await recordAudit(ctx.user.id, "financial_transaction", id, "created", `Lançamento ${input.type} criado.`);
      await recordDomainEvent({ eventName: "financial.entry.created", aggregateType: "financial_transaction", aggregateId: id, actorUserId: ctx.user.id, payload: { type: input.type, category: input.category, amount: input.amount, contractId: input.contractId ?? null } });
      return { id };
    }),

  transfers: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ transfer: financialTransfers, contractNumber: contracts.number }).from(financialTransfers).leftJoin(contracts, eq(financialTransfers.contractId, contracts.id)).orderBy(desc(financialTransfers.dueDate)).limit(300);
  }),

  createTransfer: financeProcedure.input(z.object({ contractId: z.number().int().positive().optional().nullable(), beneficiaryName: z.string().trim().min(2).max(255), description: z.string().trim().max(2000).optional().nullable(), amount: z.coerce.number().positive(), dueDate: z.string().date() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const created = await db.insert(financialTransfers).values({ ...input, contractId: input.contractId ?? null, description: input.description || null, amount: input.amount.toFixed(2), dueDate: dateValue(input.dueDate) }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar o repasse." });
      await recordAudit(ctx.user.id, "financial_transfer", id, "created", `Repasse para ${input.beneficiaryName} registrado.`);
      await recordDomainEvent({ eventName: "financial.transfer.created", aggregateType: "financial_transfer", aggregateId: id, actorUserId: ctx.user.id, payload: { beneficiaryName: input.beneficiaryName, amount: input.amount, contractId: input.contractId ?? null } });
      return { id };
    }),

  markTransferPaid: financeProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.update(financialTransfers).set({ status: "paid", paidAt: new Date() }).where(eq(financialTransfers.id, input.id));
    await recordAudit(ctx.user.id, "financial_transfer", input.id, "paid", "Repasse baixado como pago.");
    return { success: true };
  }),
});
