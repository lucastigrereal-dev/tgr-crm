import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { billingRecords, captureRecords, commercialProjectSettings, contractCancellationRequests, contractDocuments, contracts, customers, financialTransactions, financialTransfers, installments, opportunities, ownershipEntitlements, proposals, salesCommissions, users } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { storagePut } from "../storage";
import { buildInstallmentSchedule } from "../domain";
import { parseCancellationPolicy } from "../projectPolicy";
import { simulateCancellation } from "../cancellationDomain";
import { planCancellationExecution } from "../cancellationExecution";
import { syncRevenueQualityForContract } from "../revenueQualitySync";
import { decodeUpload } from "../uploadValidation";
import { canTransitionContractStatus } from "../../shared/contractLifecycle";
import { assertCapability, contractsProcedure, salesProcedure } from "./access";

export const contractsRouter = router({
  list: contractsProcedure.input(z.object({ status: z.enum(["draft", "pending_signature", "active", "overdue", "cancelled", "closed"]).optional(), limit: z.number().int().min(1).max(500).default(100) }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = input?.limit ?? 100;
    const rawRows = await db.select({ contract: contracts, customerName: customers.fullName, sellerName: users.name })
      .from(contracts).innerJoin(customers, eq(contracts.customerId, customers.id)).leftJoin(users, eq(contracts.sellerId, users.id))
      .where(input?.status ? eq(contracts.status, input.status) : undefined)
      .orderBy(desc(contracts.updatedAt)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["contratos"] : [] };
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
    const duplicate = (await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.number, input.number)).limit(1))[0];
    if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe um contrato com este número." });
    const customer = (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente do contrato não encontrado." });
    const sellerId = input.sellerId ?? ctx.user.id;
    const seller = (await db.select({ id: users.id }).from(users).where(eq(users.id, sellerId)).limit(1))[0];
    if (!seller) throw new TRPCError({ code: "NOT_FOUND", message: "Vendedor do contrato não encontrado." });
    if (input.proposalId) {
      const proposal = (await db.select({ id: proposals.id, opportunityId: proposals.opportunityId }).from(proposals).where(eq(proposals.id, input.proposalId)).limit(1))[0];
      if (!proposal) throw new TRPCError({ code: "NOT_FOUND", message: "Proposta do contrato não encontrada." });
      const opportunity = (await db.select({ customerId: opportunities.customerId }).from(opportunities).where(eq(opportunities.id, proposal.opportunityId)).limit(1))[0];
      if (!opportunity) throw new TRPCError({ code: "NOT_FOUND", message: "Oportunidade da proposta não encontrada." });
      if (opportunity.customerId !== input.customerId) throw new TRPCError({ code: "BAD_REQUEST", message: "A proposta informada não pertence ao cliente do contrato." });
    }
    const schedule = buildInstallmentSchedule(input.totalAmount, input.installmentCount, input.firstDueDate);
    const result = await db.transaction(async tx => {
      const created = await tx.insert(contracts).values({
        number: input.number,
        customerId: input.customerId,
        proposalId: input.proposalId ?? null,
        sellerId,
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
    await recordDomainEvent({ eventName: "contract.created", aggregateType: "contract", aggregateId: result, actorUserId: ctx.user.id, payload: { customerId: input.customerId, proposalId: input.proposalId ?? null, usageModel: input.usageModel, status: input.status, totalAmount: input.totalAmount, installmentCount: input.installmentCount } });
    await syncRevenueQualityForContract({ contractId: result, actorUserId: ctx.user.id, trigger: "criação de contrato" });
    return { id: result };
  }),

  detail: contractsProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return null;
    const contract = (await db.select({ contract: contracts, customerName: customers.fullName, customerEmail: customers.email, customerPhone: customers.phone })
      .from(contracts).innerJoin(customers, eq(contracts.customerId, customers.id)).where(eq(contracts.id, input.id)).limit(1))[0];
    if (!contract) return null;
    const [rawSchedule, rawDocuments, rawCancellationRequests] = await Promise.all([
      db.select().from(installments).where(eq(installments.contractId, input.id)).orderBy(installments.sequence).limit(361),
      db.select().from(contractDocuments).where(eq(contractDocuments.contractId, input.id)).orderBy(desc(contractDocuments.createdAt)).limit(101),
      db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.contractId, input.id)).orderBy(desc(contractCancellationRequests.createdAt)).limit(51),
    ]);
    const truncatedSources = [
      rawSchedule.length > 360 ? "parcelas" : null,
      rawDocuments.length > 100 ? "documentos" : null,
      rawCancellationRequests.length > 50 ? "distratos" : null,
    ].filter((source): source is string => Boolean(source));
    return {
      ...contract,
      installments: rawSchedule.slice(0, 360),
      documents: rawDocuments.slice(0, 100),
      cancellationRequests: rawCancellationRequests.slice(0, 50),
      truncated: truncatedSources.length > 0,
      truncatedSources,
    };
  }),

  simulateCancellation: salesProcedure.input(z.object({ contractId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const contract = (await db.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0]; if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
    const paid = await db.select().from(installments).where(eq(installments.contractId, input.contractId)).limit(360); const paidAmount = paid.filter(item => item.status === "paid").reduce((sum, item) => sum + Number(item.amount), 0);
    const context = await db.select({ capture: captureRecords }).from(contracts).leftJoin(proposals, eq(contracts.proposalId, proposals.id)).leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id)).leftJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id)).where(eq(contracts.id, input.contractId)).limit(1);
    const resortId = context[0]?.capture?.resortId; const settings = resortId ? (await db.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, resortId)).limit(1))[0] : null;
    return { contractId: contract.id, resortId: resortId ?? null, policy: parseCancellationPolicy(settings?.cancellationPolicy), ...simulateCancellation({ contractAmount: Number(contract.totalAmount), paidAmount, policy: parseCancellationPolicy(settings?.cancellationPolicy) }) };
  }),

  requestCancellation: salesProcedure.input(z.object({ contractId: z.number().int().positive(), reason: z.string().trim().min(3).max(2000) })).mutation(async ({ ctx, input }) => {
    assertCapability(ctx.user.role, "contract.cancel.request");
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const requested = await db.transaction(async tx => {
      const contract = (await tx.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
      if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
      if (contract.status === "cancelled") throw new TRPCError({ code: "CONFLICT", message: "Contrato já está cancelado." });
      const existingRequest = (await tx.select({ id: contractCancellationRequests.id }).from(contractCancellationRequests).where(and(eq(contractCancellationRequests.contractId, input.contractId), inArray(contractCancellationRequests.status, ["requested", "approved"]))).limit(1))[0];
      if (existingRequest) throw new TRPCError({ code: "CONFLICT", message: "Já existe um distrato aguardando decisão ou execução para este contrato." });
      const paid = await tx.select().from(installments).where(eq(installments.contractId, input.contractId)).limit(360);
      const paidAmount = paid.filter(item => item.status === "paid").reduce((sum, item) => sum + Number(item.amount), 0);
      const context = await tx.select({ capture: captureRecords }).from(contracts).leftJoin(proposals, eq(contracts.proposalId, proposals.id)).leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id)).leftJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id)).where(eq(contracts.id, input.contractId)).limit(1);
      const resortId = context[0]?.capture?.resortId;
      const settings = resortId ? (await tx.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, resortId)).limit(1))[0] : null;
      const simulation = simulateCancellation({ contractAmount: Number(contract.totalAmount), paidAmount, policy: parseCancellationPolicy(settings?.cancellationPolicy) });
      const created = await tx.insert(contractCancellationRequests).values({ contractId: input.contractId, reason: input.reason, simulationSnapshot: JSON.stringify(simulation), requestedByUserId: ctx.user.id }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível solicitar o distrato." });
      return { id, simulation };
    });
    await recordAudit(ctx.user.id, "contract_cancellation_request", requested.id, "requested", `Distrato solicitado para contrato ${input.contractId}.`);
    await recordDomainEvent({ eventName: "contract.cancellation.requested", aggregateType: "contract_cancellation_request", aggregateId: requested.id, actorUserId: ctx.user.id, payload: { contractId: input.contractId, paidAmount: requested.simulation.paidAmount } });
    return requested;
  }),
  decideCancellation: contractsProcedure.input(z.object({ requestId: z.number().int().positive(), decision: z.enum(["approved", "rejected"]), notes: z.string().trim().max(2000).optional() })).mutation(async ({ ctx, input }) => {
    assertCapability(ctx.user.role, "contract.cancel.decide");
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const request = (await db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.id, input.requestId)).limit(1))[0]; if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Solicitação de distrato não encontrada." }); if (request.status !== "requested") throw new TRPCError({ code: "CONFLICT", message: "Esta solicitação já recebeu uma decisão." });
    const updateResult = await db.update(contractCancellationRequests).set({ status: input.decision, decidedByUserId: ctx.user.id, decisionNotes: input.notes?.trim() || null, decidedAt: new Date() }).where(and(eq(contractCancellationRequests.id, input.requestId), eq(contractCancellationRequests.status, "requested")));
    if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "A solicitação de distrato foi alterada por outra operação." });
    await recordAudit(ctx.user.id, "contract_cancellation_request", input.requestId, input.decision, `Distrato ${input.decision}.`);
    await recordDomainEvent({ eventName: "contract.cancellation.decided", aggregateType: "contract_cancellation_request", aggregateId: input.requestId, actorUserId: ctx.user.id, payload: { decision: input.decision } });
    return { success: true };
  }),

  executeCancellation: contractsProcedure.input(z.object({ requestId: z.number().int().positive(), executionNotes: z.string().trim().max(2000).optional() })).mutation(async ({ ctx, input }) => {
    assertCapability(ctx.user.role, "contract.cancel.execute");
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const createdFinancialEntryFacts: Array<{ id: number; contractId: number; type: "income" | "expense"; category: string; amount: number }> = [];
    const outcome = await db.transaction(async tx => {
      const request = (await tx.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.id, input.requestId)).limit(1).for("update"))[0];
      if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Solicitação de distrato não encontrada." });
      if (request.status !== "approved") throw new TRPCError({ code: "CONFLICT", message: "Somente distrato aprovado pode ser executado." });
      const contract = (await tx.select().from(contracts).where(eq(contracts.id, request.contractId)).limit(1).for("update"))[0];
      if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
      if (contract.status === "cancelled") throw new TRPCError({ code: "CONFLICT", message: "Contrato já está cancelado." });
      const schedule = await tx.select({ id: installments.id, amount: installments.amount, status: installments.status }).from(installments).where(eq(installments.contractId, contract.id));
      const commissionRows = await tx.select({ id: salesCommissions.id, status: salesCommissions.status }).from(salesCommissions).where(eq(salesCommissions.contractId, contract.id)).for("update");
      const impact = planCancellationExecution({ requestStatus: request.status, contractStatus: contract.status, installments: schedule, commissions: commissionRows });
      const simulation = JSON.parse(request.simulationSnapshot) as { paidAmount?: number; penalty?: number; retained?: number; refund?: number };
      const currentPaidAmount = schedule.filter(item => item.status === "paid").reduce((sum, item) => sum + Number(item.amount), 0);
      if (simulation.paidAmount !== undefined && Math.abs(currentPaidAmount - Number(simulation.paidAmount)) > 0.005) throw new TRPCError({ code: "CONFLICT", message: "As parcelas pagas mudaram desde a aprovação do distrato. Solicite uma nova simulação antes de executar." });
      const settlementDate = new Date();
      await tx.update(contracts).set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: request.reason }).where(eq(contracts.id, contract.id));
      const cancelledInstallments = impact.cancelInstallmentIds.length ? await tx.update(installments).set({ status: "cancelled" }).where(inArray(installments.id, impact.cancelInstallmentIds)) : [{ affectedRows: 0 }];
      const cancelledCommissions = impact.cancelCommissionIds.length ? await tx.update(salesCommissions).set({ status: "cancelled", lifecycleStatus: "cancelled", cancelledAt: new Date(), notes: input.executionNotes?.trim() || "Cancelada por distrato aprovado" }).where(inArray(salesCommissions.id, impact.cancelCommissionIds)) : [{ affectedRows: 0 }];
      await tx.update(financialTransactions).set({ status: "cancelled" }).where(and(eq(financialTransactions.contractId, contract.id), eq(financialTransactions.status, "open")));
      await tx.update(financialTransfers).set({ status: "cancelled" }).where(and(eq(financialTransfers.contractId, contract.id), eq(financialTransfers.status, "pending")));
      await tx.update(ownershipEntitlements).set({ status: "cancelled" }).where(and(eq(ownershipEntitlements.contractId, contract.id), ne(ownershipEntitlements.status, "cancelled")));
      if (impact.cancelInstallmentIds.length) await tx.update(billingRecords).set({ status: "cancelled" }).where(and(inArray(billingRecords.installmentId, impact.cancelInstallmentIds), inArray(billingRecords.status, ["pending", "generated", "expired"])));
      const financialImpact = [] as Array<{ contractId: number; type: "income" | "expense"; category: string; description: string; amount: string; dueDate: Date; status: "open"; createdByUserId: number }>;
      if (Number(simulation.penalty ?? 0) > 0 || Number(simulation.retained ?? 0) > 0) financialImpact.push({ contractId: contract.id, type: "income", category: "Distrato · multa/retenção", description: `Impacto previsto do distrato aprovado #${request.id}`, amount: Number(simulation.penalty ?? simulation.retained ?? 0).toFixed(2), dueDate: settlementDate, status: "open", createdByUserId: ctx.user.id });
      if (Number(simulation.refund ?? 0) > 0) financialImpact.push({ contractId: contract.id, type: "expense", category: "Distrato · reembolso", description: `Reembolso previsto do distrato aprovado #${request.id}`, amount: Number(simulation.refund).toFixed(2), dueDate: settlementDate, status: "open", createdByUserId: ctx.user.id });
      if (financialImpact.length) { const insertedFinancialEntries = await tx.insert(financialTransactions).values(financialImpact).$returningId(); insertedFinancialEntries.forEach((inserted, index) => { const entry = financialImpact[index]; if (entry && inserted?.id) createdFinancialEntryFacts.push({ id: inserted.id, contractId: entry.contractId, type: entry.type, category: entry.category, amount: Number(entry.amount) }); }); }
      await tx.update(contractCancellationRequests).set({ status: "executed", executedAt: new Date(), decisionNotes: [request.decisionNotes, input.executionNotes?.trim()].filter(Boolean).join("\n") || null }).where(eq(contractCancellationRequests.id, request.id));
      return { contractId: contract.id, cancelledInstallmentIds: impact.cancelInstallmentIds, cancelledCommissionIds: impact.cancelCommissionIds, cancelledInstallments: Number(cancelledInstallments[0]?.affectedRows ?? 0), cancelledCommissions: Number(cancelledCommissions[0]?.affectedRows ?? 0), financialEntries: financialImpact.length };
    });
    await recordAudit(ctx.user.id, "contract_cancellation_request", input.requestId, "executed", `Distrato executado para contrato ${outcome.contractId}; parcelas canceladas: ${outcome.cancelledInstallments}; comissões canceladas: ${outcome.cancelledCommissions}; lançamentos financeiros: ${outcome.financialEntries}.`);
    await recordDomainEvent({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: outcome.contractId, actorUserId: ctx.user.id, payload: { status: "cancelled", cancellationReason: "Distrato aprovado executado" } });
    for (const commissionId of outcome.cancelledCommissionIds) { await recordAudit(ctx.user.id, "sales_commission", commissionId, "cancelled", `Comissão cancelada pelo distrato do contrato ${outcome.contractId}.`); await recordDomainEvent({ eventName: "commission.status.updated", aggregateType: "sales_commission", aggregateId: commissionId, actorUserId: ctx.user.id, payload: { status: "cancelled", contractId: outcome.contractId } }); }
    for (const entry of createdFinancialEntryFacts) { await recordAudit(ctx.user.id, "financial_transaction", entry.id, "created", `Lançamento ${entry.type} de ${entry.amount.toFixed(2)} criado pelo distrato.`); await recordDomainEvent({ eventName: "financial.entry.created", aggregateType: "financial_transaction", aggregateId: entry.id, actorUserId: ctx.user.id, payload: { type: entry.type, category: entry.category, amount: entry.amount, contractId: entry.contractId, campaignId: null } }); }
    await syncRevenueQualityForContract({ contractId: outcome.contractId, actorUserId: ctx.user.id, trigger: "execução de distrato" });
    return { success: true, ...outcome };
  }),

  updateStatus: salesProcedure.input(z.object({
    id: z.number().int().positive(),
    status: z.enum(["draft", "pending_signature", "active", "overdue", "cancelled", "closed"]),
    cancellationReason: z.string().trim().max(2000).optional().nullable(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const current = (await db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, input.id)).limit(1))[0];
    if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
    if (!canTransitionContractStatus(current.status, input.status)) throw new TRPCError({ code: "CONFLICT", message: `Transição de contrato inválida: ${current.status} → ${input.status}.` });
    if (input.status === "cancelled" && !input.cancellationReason?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Informe o motivo do cancelamento do contrato." });
    const updateResult = await db.update(contracts).set({
      status: input.status,
      activatedAt: input.status === "active" ? new Date() : undefined,
      cancelledAt: input.status === "cancelled" ? new Date() : undefined,
      cancellationReason: input.status === "cancelled" ? input.cancellationReason!.trim() : null,
    }).where(and(eq(contracts.id, input.id), eq(contracts.status, current.status)));
    if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "O contrato foi alterado por outra operação. Recarregue e tente novamente." });
    await recordAudit(ctx.user.id, "contract", input.id, "status_updated", `Status alterado para ${input.status}.`);
    await recordDomainEvent({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: input.id, actorUserId: ctx.user.id, payload: { status: input.status, cancellationReason: input.status === "cancelled" ? input.cancellationReason ?? null : null } });
    await syncRevenueQualityForContract({ contractId: input.id, actorUserId: ctx.user.id, trigger: "alteração de status do contrato" });
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
    const contract = (await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
    if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato do documento não encontrado." });
    const buffer = decodeUpload(input.base64);
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    let upload: { key: string; url: string };
    try {
      upload = await storagePut(`contracts/${input.contractId}/${Date.now()}-${safeName}`, buffer, input.contentType);
    } catch {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível armazenar o documento do contrato." });
    }
    const created = await db.insert(contractDocuments).values({
      contractId: input.contractId,
      category: input.category,
      filename: input.filename,
      storageKey: upload.key,
      signed: false,
      uploadedByUserId: ctx.user.id,
    }).$returningId();
    const id = created[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar o documento." });
    await recordAudit(ctx.user.id, "contract_document", id, "uploaded", `Documento ${input.filename} anexado.`);
    await recordDomainEvent({ eventName: "contract.document.uploaded", aggregateType: "contract_document", aggregateId: id, actorUserId: ctx.user.id, payload: { contractId: input.contractId, category: input.category, signed: false, filename: input.filename } });
    return { id, url: upload.url };
  }),

  markDocumentSigned: contractsProcedure.input(z.object({ documentId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    assertCapability(ctx.user.role, "document.sign", "Somente a administração pode confirmar assinatura documental.");
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const document = (await db.select({ id: contractDocuments.id, contractId: contractDocuments.contractId, signed: contractDocuments.signed }).from(contractDocuments).where(eq(contractDocuments.id, input.documentId)).limit(1))[0];
    if (!document) throw new TRPCError({ code: "NOT_FOUND", message: "Documento contratual não encontrado." });
    if (document.signed) return { success: true, alreadySigned: true } as const;
    const updateResult = await db.update(contractDocuments).set({ signed: true }).where(and(eq(contractDocuments.id, input.documentId), eq(contractDocuments.signed, false)));
    if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) return { success: true, alreadySigned: true } as const;
    await recordAudit(ctx.user.id, "contract_document", input.documentId, "signed", `Assinatura do documento contratual #${input.documentId} confirmada.`);
    await recordDomainEvent({ eventName: "contract.document.signed", aggregateType: "contract_document", aggregateId: input.documentId, actorUserId: ctx.user.id, payload: { contractId: document.contractId } });
    return { success: true, alreadySigned: false } as const;
  }),
});
