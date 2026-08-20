import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, commercialProjectSettings, contractDocuments, contracts, customers, installments, opportunities, proposals, users } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { storagePut } from "../storage";
import { buildInstallmentSchedule } from "../domain";
import { parseCancellationPolicy } from "../projectPolicy";
import { simulateCancellation } from "../cancellationDomain";
import { contractsProcedure, salesProcedure } from "./access";

export const contractsRouter = router({
  list: contractsProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ contract: contracts, customerName: customers.fullName, sellerName: users.name })
      .from(contracts).innerJoin(customers, eq(contracts.customerId, customers.id)).leftJoin(users, eq(contracts.sellerId, users.id))
      .orderBy(desc(contracts.updatedAt)).limit(100);
  }),

  create: salesProcedure.input(z.object({
    number: z.string().trim().min(3).max(80),
    customerId: z.number().int().positive(),
    proposalId: z.number().int().positive().optional().nullable(),
    sellerId: z.number().int().positive().optional().nullable(),
    usageModel: z.enum(["fixed_week", "flexible_week", "points"]).default("fixed_week"),
    status: z.enum(["draft", "pending_signature", "active", "overdue", "cancelled", "closed"]).default("draft"),
    totalAmount: z.coerce.number().positive().max(999999999),
    firstDueDate: z.string().date(),
    installmentCount: z.coerce.number().int().min(1).max(360),
    notes: z.string().trim().max(5000).optional().nullable(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const schedule = buildInstallmentSchedule(input.totalAmount, input.installmentCount, input.firstDueDate);
    const result = await db.transaction(async tx => {
      const created = await tx.insert(contracts).values({
        number: input.number,
        customerId: input.customerId,
        proposalId: input.proposalId ?? null,
        sellerId: input.sellerId ?? ctx.user.id,
        usageModel: input.usageModel,
        status: input.status,
        totalAmount: input.totalAmount.toFixed(2),
        activatedAt: input.status === "active" ? new Date() : null,
        notes: input.notes?.trim() || null,
      }).$returningId();
      const contractId = created[0]?.id;
      if (!contractId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o contrato." });
      await tx.insert(installments).values(schedule.map(item => ({
        contractId,
        sequence: item.sequence,
        dueDate: item.dueDate,
        amount: item.amount,
        status: "open" as const,
      })));
      return contractId;
    });
    await recordAudit(ctx.user.id, "contract", result, "created", `Contrato ${input.number} criado com ${input.installmentCount} parcelas.`);
    await recordDomainEvent({ eventName: "contract.created", aggregateType: "contract", aggregateId: result, actorUserId: ctx.user.id, payload: { customerId: input.customerId, proposalId: input.proposalId ?? null, status: input.status, totalAmount: input.totalAmount, installmentCount: input.installmentCount } });
    return { id: result };
  }),

  detail: contractsProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return null;
    const contract = (await db.select({ contract: contracts, customerName: customers.fullName, customerEmail: customers.email, customerPhone: customers.phone })
      .from(contracts).innerJoin(customers, eq(contracts.customerId, customers.id)).where(eq(contracts.id, input.id)).limit(1))[0];
    if (!contract) return null;
    const [schedule, documents] = await Promise.all([
      db.select().from(installments).where(eq(installments.contractId, input.id)).orderBy(installments.sequence),
      db.select().from(contractDocuments).where(eq(contractDocuments.contractId, input.id)).orderBy(desc(contractDocuments.createdAt)),
    ]);
    return { ...contract, installments: schedule, documents };
  }),

  simulateCancellation: salesProcedure.input(z.object({ contractId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const contract = (await db.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0]; if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
    const paid = await db.select().from(installments).where(eq(installments.contractId, input.contractId)); const paidAmount = paid.filter(item => item.status === "paid").reduce((sum, item) => sum + Number(item.amount), 0);
    const context = await db.select({ capture: captureRecords }).from(contracts).leftJoin(proposals, eq(contracts.proposalId, proposals.id)).leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id)).leftJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id)).where(eq(contracts.id, input.contractId)).limit(1);
    const resortId = context[0]?.capture?.resortId; const settings = resortId ? (await db.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, resortId)).limit(1))[0] : null;
    return { contractId: contract.id, resortId: resortId ?? null, policy: parseCancellationPolicy(settings?.cancellationPolicy), ...simulateCancellation({ contractAmount: Number(contract.totalAmount), paidAmount, policy: parseCancellationPolicy(settings?.cancellationPolicy) }) };
  }),

  updateStatus: salesProcedure.input(z.object({
    id: z.number().int().positive(),
    status: z.enum(["draft", "pending_signature", "active", "overdue", "cancelled", "closed"]),
    cancellationReason: z.string().trim().max(2000).optional().nullable(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.update(contracts).set({
      status: input.status,
      activatedAt: input.status === "active" ? new Date() : undefined,
      cancelledAt: input.status === "cancelled" ? new Date() : undefined,
      cancellationReason: input.status === "cancelled" ? input.cancellationReason?.trim() || "Cancelamento registrado" : null,
    }).where(eq(contracts.id, input.id));
    await recordAudit(ctx.user.id, "contract", input.id, "status_updated", `Status alterado para ${input.status}.`);
    await recordDomainEvent({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: input.id, actorUserId: ctx.user.id, payload: { status: input.status, cancellationReason: input.status === "cancelled" ? input.cancellationReason ?? null : null } });
    return { success: true };
  }),

  uploadDocument: salesProcedure.input(z.object({
    contractId: z.number().int().positive(),
    category: z.string().trim().min(2).max(80),
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(3).max(120),
    base64: z.string().min(20),
    signed: z.boolean().default(false),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const payload = input.base64.includes(",") ? input.base64.split(",").at(-1)! : input.base64;
    const buffer = Buffer.from(payload, "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new TRPCError({ code: "BAD_REQUEST", message: "O anexo deve ter até 5 MB." });
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const upload = await storagePut(`contracts/${input.contractId}/${Date.now()}-${safeName}`, buffer, input.contentType);
    const created = await db.insert(contractDocuments).values({
      contractId: input.contractId,
      category: input.category,
      filename: input.filename,
      storageKey: upload.key,
      signed: input.signed,
      uploadedByUserId: ctx.user.id,
    }).$returningId();
    const id = created[0]?.id ?? 0;
    await recordAudit(ctx.user.id, "contract_document", id, "uploaded", `Documento ${input.filename} anexado.`);
    await recordDomainEvent({ eventName: "contract.document.uploaded", aggregateType: "contract_document", aggregateId: id, actorUserId: ctx.user.id, payload: { contractId: input.contractId, category: input.category, signed: input.signed, filename: input.filename } });
    return { id, url: upload.url };
  }),
});
