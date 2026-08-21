import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { billingRecords, captureRecords, commercialProjectSettings, contractCancellationRequests, contracts, customers, financialPortfolioAssignments, financialTransactions, financialTransfers, installmentRenegotiations, installments, opportunities, proposals, revenueQualityLedger, salesCampaigns, salesCommissions, users } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { financeProcedure } from "./access";
import { getCollectionStage } from "../domain";
import { buildCampaignDre } from "../financeDre";
import { buildInstallmentCommissions } from "../commissionAutomation";
import { parseCommissionPolicy } from "../projectPolicy";
import { buildRevenueQualityLedger, summarizeRevenueQualityLedger } from "../revenueQualityLedger";
import { buildPersistableRevenueProjection } from "../revenueQualityProjection";
import { buildFinancialPortfolioScorecards } from "../financialPortfolioScorecard";

const dateValue = (value: string) => new Date(`${value}T12:00:00Z`);

export const financeRouter = router({
  portfolioScorecards: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const [assignmentRows, installmentRows, ownerRows] = await Promise.all([
      db.select().from(financialPortfolioAssignments).where(isNull(financialPortfolioAssignments.endsAt)),
      db.select().from(installments),
      db.select({ id: users.id, name: users.name, email: users.email }).from(users),
    ]);
    const names = new Map(ownerRows.map(owner => [owner.id, owner.name || owner.email || `Usuário #${owner.id}`]));
    return buildFinancialPortfolioScorecards(assignmentRows.map(assignment => ({ contractId: assignment.contractId, ownerUserId: assignment.ownerUserId, startsAt: assignment.startsAt })), installmentRows.map(installment => ({ contractId: installment.contractId, amount: installment.amount, status: installment.status, paidAt: installment.paidAt }))).map(scorecard => ({ ...scorecard, ownerName: names.get(scorecard.ownerUserId) || `Usuário #${scorecard.ownerUserId}` }));
  }),

  portfolioCandidates: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(inArray(users.role, ["admin", "finance"])).orderBy(users.name);
  }),

  portfolioAssignments: financeProcedure.input(z.object({ contractId: z.number().int().positive().optional() }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ assignment: financialPortfolioAssignments, contractNumber: contracts.number, ownerName: users.name, ownerEmail: users.email }).from(financialPortfolioAssignments).innerJoin(contracts, eq(financialPortfolioAssignments.contractId, contracts.id)).innerJoin(users, eq(financialPortfolioAssignments.ownerUserId, users.id)).where(and(input?.contractId ? eq(financialPortfolioAssignments.contractId, input.contractId) : undefined, isNull(financialPortfolioAssignments.endsAt))).orderBy(desc(financialPortfolioAssignments.startsAt));
  }),

  assignPortfolioOwner: financeProcedure.input(z.object({ contractId: z.number().int().positive(), ownerUserId: z.number().int().positive(), notes: z.string().trim().max(2000).optional().nullable() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const contract = (await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
    if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
    const owner = (await db.select({ id: users.id }).from(users).where(eq(users.id, input.ownerUserId)).limit(1))[0];
    if (!owner) throw new TRPCError({ code: "NOT_FOUND", message: "Responsável financeiro não encontrado." });
    const now = new Date();
    const assignmentId = await db.transaction(async tx => {
      await tx.update(financialPortfolioAssignments).set({ endsAt: now }).where(and(eq(financialPortfolioAssignments.contractId, input.contractId), isNull(financialPortfolioAssignments.endsAt)));
      const created = await tx.insert(financialPortfolioAssignments).values({ contractId: input.contractId, ownerUserId: input.ownerUserId, assignedByUserId: ctx.user.id, startsAt: now, notes: input.notes || null }).$returningId();
      return created[0]?.id;
    });
    if (!assignmentId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível atribuir a carteira financeira." });
    await recordAudit(ctx.user.id, "financial_portfolio_assignment", assignmentId, "assigned", `Carteira do contrato ${input.contractId} atribuída ao usuário ${input.ownerUserId}.`);
    await recordDomainEvent({ eventName: "financial.portfolio.assigned", aggregateType: "financial_portfolio_assignment", aggregateId: assignmentId, actorUserId: ctx.user.id, payload: { contractId: input.contractId, ownerUserId: input.ownerUserId } });
    return { id: assignmentId, contractId: input.contractId, ownerUserId: input.ownerUserId, startsAt: now };
  }),

  revenueQuality: financeProcedure.input(z.object({ contractId: z.number().int().positive().optional() }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    const contractRows = await db.select().from(contracts).where(input?.contractId ? eq(contracts.id, input.contractId) : undefined).limit(input?.contractId ? 1 : 300);
    if (!contractRows.length) return [];
    const contractIds = contractRows.map(contract => contract.id);
    const [installmentRows, commissionRows, cancellationRows] = await Promise.all([
      db.select().from(installments).where(inArray(installments.contractId, contractIds)),
      db.select().from(salesCommissions).where(inArray(salesCommissions.contractId, contractIds)),
      db.select().from(contractCancellationRequests).where(inArray(contractCancellationRequests.contractId, contractIds)),
    ]);
    return contractRows.map(contract => {
      const cancellation = cancellationRows.filter(row => row.contractId === contract.id).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
      const facts = buildRevenueQualityLedger({
        contract: { id: contract.id, totalAmount: contract.totalAmount, status: contract.status },
        installments: installmentRows.filter(row => row.contractId === contract.id).map(row => ({ id: row.id, sequence: row.sequence, amount: row.amount, status: row.status })),
        commissions: commissionRows.filter(row => row.contractId === contract.id).map(row => ({ id: row.id, amount: row.amount, status: row.status, lifecycleStatus: row.lifecycleStatus, sourceInstallmentId: row.sourceInstallmentId })),
        cancellation: cancellation ? { status: cancellation.status } : null,
        policyVersion: "tgr-derived-ledger/v1",
      });
      return { contractId: contract.id, contractNumber: contract.number, policyVersion: "tgr-derived-ledger/v1", summary: summarizeRevenueQualityLedger(facts), facts };
    });
  }),

  syncRevenueQualityLedger: financeProcedure.input(z.object({ contractId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const contract = (await db.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
    if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
    const [installmentRows, commissionRows, cancellationRows] = await Promise.all([
      db.select().from(installments).where(eq(installments.contractId, contract.id)),
      db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contract.id)),
      db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.contractId, contract.id)),
    ]);
    const cancellation = cancellationRows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    const policyVersion = "tgr-derived-ledger/v1";
    const projection = buildPersistableRevenueProjection({
      contract: { id: contract.id, totalAmount: contract.totalAmount, status: contract.status },
      installments: installmentRows.map(row => ({ id: row.id, sequence: row.sequence, amount: row.amount, status: row.status })),
      commissions: commissionRows.map(row => ({ id: row.id, amount: row.amount, status: row.status, lifecycleStatus: row.lifecycleStatus, sourceInstallmentId: row.sourceInstallmentId })),
      cancellation: cancellation ? { status: cancellation.status } : null,
      policyVersion,
    });
    if (projection.length) await db.insert(revenueQualityLedger).values(projection.map(fact => ({ contractId: fact.contractId, installmentId: fact.installmentId ?? null, commissionId: fact.commissionId ?? null, domainEventId: null, policyVersionId: null, factType: fact.type, amount: fact.amount.toFixed(2), reason: fact.reason ?? null, sourceFingerprint: fact.sourceFingerprint, occurredAt: new Date() }))).onDuplicateKeyUpdate({ set: { sourceFingerprint: sql`sourceFingerprint` } });
    await recordAudit(ctx.user.id, "revenue_quality_ledger", contract.id, "synced", `${projection.length} fato(s) econômicos projetados pela política ${policyVersion}.`);
    await recordDomainEvent({ eventName: "revenue_quality_ledger.synced", aggregateType: "contract", aggregateId: contract.id, actorUserId: ctx.user.id, payload: { factCount: projection.length, policyVersion } });
    return { contractId: contract.id, factCount: projection.length, policyVersion, summary: summarizeRevenueQualityLedger(projection) };
  }),

  installments: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ installment: installments, contractNumber: contracts.number, customerName: customers.fullName })
      .from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id))
      .orderBy(desc(installments.dueDate)).limit(300);
  }),

  collectionQueue: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const now = new Date();
    const rows = await db.select({ installment: installments, contractNumber: contracts.number, customerName: customers.fullName })
      .from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id))
      .where(inArray(installments.status, ["open", "overdue"]))
      .orderBy(installments.dueDate).limit(120);
    return rows.map(item => {
      const dueDate = new Date(item.installment.dueDate);
      const collection = getCollectionStage(dueDate, now);
      return { ...item, collection, daysPastDue: Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000)) };
    });
  }),

  billing: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ billing: billingRecords, installmentSequence: installments.sequence, contractNumber: contracts.number, customerName: customers.fullName })
      .from(billingRecords).innerJoin(installments, eq(billingRecords.installmentId, installments.id)).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id))
      .orderBy(desc(billingRecords.createdAt)).limit(300);
  }),

  simulateRenegotiation: financeProcedure.input(z.object({ installmentId: z.number().int().positive(), proposedAmount: z.coerce.number().positive(), proposedDueDate: z.string().date() })).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const installment = (await db.select().from(installments).where(eq(installments.id, input.installmentId)).limit(1))[0]; if (!installment) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
    if (installment.status === "paid" || installment.status === "cancelled") throw new TRPCError({ code: "BAD_REQUEST", message: "Esta parcela não pode ser renegociada." });
    const originalAmount = Number(installment.amount); if (input.proposedAmount > originalAmount) throw new TRPCError({ code: "BAD_REQUEST", message: "O acordo não pode aumentar a parcela original." });
    return { contractId: installment.contractId, originalAmount, proposedAmount: input.proposedAmount, discountAmount: Number((originalAmount - input.proposedAmount).toFixed(2)), proposedDueDate: input.proposedDueDate };
  }),

  createRenegotiation: financeProcedure.input(z.object({ installmentId: z.number().int().positive(), proposedAmount: z.coerce.number().positive(), proposedDueDate: z.string().date(), notes: z.string().trim().max(2000).nullable().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const installment = (await db.select().from(installments).where(eq(installments.id, input.installmentId)).limit(1))[0]; if (!installment) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
    const originalAmount = Number(installment.amount); if (installment.status === "paid" || input.proposedAmount > originalAmount) throw new TRPCError({ code: "BAD_REQUEST", message: "Acordo inválido para esta parcela." });
    const created = await db.insert(installmentRenegotiations).values({ contractId: installment.contractId, originalInstallmentId: installment.id, originalAmount: originalAmount.toFixed(2), proposedAmount: input.proposedAmount.toFixed(2), proposedDueDate: dateValue(input.proposedDueDate), discountAmount: (originalAmount - input.proposedAmount).toFixed(2), notes: input.notes || null, createdByUserId: ctx.user.id }).$returningId(); const id = created[0]?.id; if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o acordo." });
    await recordAudit(ctx.user.id, "installment_renegotiation", id, "created", `Acordo proposto para parcela ${installment.sequence}.`); await recordDomainEvent({ eventName: "installment.renegotiation.proposed", aggregateType: "installment_renegotiation", aggregateId: id, actorUserId: ctx.user.id, payload: { installmentId: installment.id, proposedAmount: input.proposedAmount } }); return { id };
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
      const contextQuery = db.select({ contract: contracts, proposal: proposals, opportunity: opportunities, capture: captureRecords }).from(contracts); const commissionContext = typeof (contextQuery as any).leftJoin === "function" ? (await (contextQuery as any).leftJoin(proposals, eq(contracts.proposalId, proposals.id)).leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id)).leftJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id)).where(eq(contracts.id, item.contractId)).limit(1))[0] : null;
      const policyRow = commissionContext?.capture?.resortId ? (await db.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, commissionContext.capture.resortId)).limit(1))[0] : null; const commissionPolicy = parseCommissionPolicy(policyRow?.commissionPolicy);
      await db.transaction(async tx => {
        await tx.update(installments).set({ status: "paid", paidAt: new Date(), paymentMethod: input.paymentMethod || null }).where(eq(installments.id, input.id));
        await tx.update(billingRecords).set({ status: "paid" }).where(eq(billingRecords.installmentId, input.id));
        await tx.insert(financialTransactions).values({ contractId: item.contractId, campaignId: null, type: "income", category: "Parcela de contrato", description: `Baixa da parcela ${item.sequence}`, amount: item.amount, dueDate: item.dueDate, paidAt: new Date(), status: "paid", createdByUserId: ctx.user.id });
        if (commissionContext?.proposal && commissionContext.capture && Number(commissionContext.proposal.downPaymentAmount) > 0) { const exists = await tx.select({ id: salesCommissions.id }).from(salesCommissions).where(eq(salesCommissions.sourceInstallmentId, item.id)).limit(1); if (!exists.length) { const method = (["pix", "debit", "credit", "boleto", "cash", "cheque"].includes((input.paymentMethod || "").toLowerCase()) ? (input.paymentMethod || "").toLowerCase() : "other") as Parameters<typeof buildInstallmentCommissions>[0]["paymentMethod"]; const rows = buildInstallmentCommissions({ installmentId: item.id, installmentAmount: Number(item.amount), entryTotal: Number(commissionContext.proposal.downPaymentAmount), contractTotal: Number(commissionContext.contract.totalAmount), paymentMethod: method, compensatedAt: new Date(), linerId: commissionContext.capture.linerId, closerId: commissionContext.capture.closerId, rates: { liner: commissionPolicy.linerRate, closer: commissionPolicy.closerRate, ftb: commissionPolicy.ftbRate }, calendar: { cancellationDeadlineDay: commissionPolicy.cancellationDeadlineDay, expectedPaymentDay: commissionPolicy.expectedPaymentDay } }); if (rows.length) await tx.insert(salesCommissions).values(rows.map(row => ({ ...row, contractId: item.contractId, opportunityId: commissionContext.opportunity?.id ?? null, campaignId: commissionContext.capture?.campaignId ?? null, baseAmount: row.baseAmount.toFixed(2), rate: row.rate.toFixed(2), amount: row.amount.toFixed(2), lifecycleStatus: row.lifecycleStatus, paymentMethod: row.paymentMethod }))); } }
      });
      await recordAudit(ctx.user.id, "installment", input.id, "paid", `Parcela ${item.sequence} baixada como paga.`);
      await recordDomainEvent({ eventName: "installment.paid", aggregateType: "installment", aggregateId: input.id, actorUserId: ctx.user.id, payload: { contractId: item.contractId, sequence: item.sequence, amount: item.amount } });
      return { success: true };
    }),

  entries: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ entry: financialTransactions, contractNumber: contracts.number, campaignName: salesCampaigns.name }).from(financialTransactions).leftJoin(contracts, eq(financialTransactions.contractId, contracts.id)).leftJoin(salesCampaigns, eq(financialTransactions.campaignId, salesCampaigns.id)).orderBy(desc(financialTransactions.createdAt)).limit(300);
  }),

  campaigns: financeProcedure.query(async () => {
    const db = await getDb(); if (!db) return [];
    return db.select({ id: salesCampaigns.id, name: salesCampaigns.name, code: salesCampaigns.code, status: salesCampaigns.status }).from(salesCampaigns).orderBy(salesCampaigns.name).limit(200);
  }),

  dreByCampaign: financeProcedure.input(z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).optional()).query(async ({ input }) => {
    const db = await getDb(); if (!db) return [];
    const [transactions, campaigns] = await Promise.all([
      db.select({ entry: financialTransactions, inheritedCampaignId: opportunities.campaignId }).from(financialTransactions).leftJoin(contracts, eq(financialTransactions.contractId, contracts.id)).leftJoin(proposals, eq(contracts.proposalId, proposals.id)).leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id)).where(and(eq(financialTransactions.status, "paid"), isNotNull(financialTransactions.paidAt), input?.from ? gte(financialTransactions.paidAt, dateValue(input.from)) : undefined, input?.to ? lte(financialTransactions.paidAt, new Date(`${input.to}T23:59:59Z`)) : undefined)),
      db.select({ id: salesCampaigns.id, name: salesCampaigns.name }).from(salesCampaigns),
    ]);
    const campaignNames = new Map(campaigns.map(campaign => [campaign.id, campaign.name]));
    return buildCampaignDre(transactions.map(({ entry, inheritedCampaignId }) => { const campaignId = entry.campaignId ?? inheritedCampaignId ?? null; return { campaignId, campaignName: campaignId ? campaignNames.get(campaignId) ?? null : null, type: entry.type, amount: entry.amount }; }));
  }),

  createEntry: financeProcedure.input(z.object({ contractId: z.number().int().positive().optional().nullable(), campaignId: z.number().int().positive().optional().nullable(), type: z.enum(["income", "expense"]), category: z.string().trim().min(2).max(120), description: z.string().trim().min(2).max(2000), amount: z.coerce.number().positive(), dueDate: z.string().date().optional().nullable(), status: z.enum(["open", "paid"]).default("open") }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const created = await db.insert(financialTransactions).values({ ...input, contractId: input.contractId ?? null, campaignId: input.campaignId ?? null, amount: input.amount.toFixed(2), dueDate: input.dueDate ? dateValue(input.dueDate) : null, paidAt: input.status === "paid" ? new Date() : null, createdByUserId: ctx.user.id }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o lançamento." });
      await recordAudit(ctx.user.id, "financial_transaction", id, "created", `Lançamento ${input.type} criado.`);
      await recordDomainEvent({ eventName: "financial.entry.created", aggregateType: "financial_transaction", aggregateId: id, actorUserId: ctx.user.id, payload: { type: input.type, category: input.category, amount: input.amount, contractId: input.contractId ?? null, campaignId: input.campaignId ?? null } });
      return { id };
    }),

  reconcileEntry: financeProcedure.input(z.object({ id: z.number().int().positive(), reconciliationReference: z.string().trim().min(3).max(255) })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const entry = (await db.select().from(financialTransactions).where(eq(financialTransactions.id, input.id)).limit(1))[0];
    if (!entry) throw new TRPCError({ code: "NOT_FOUND", message: "Lançamento não encontrado." });
    if (entry.status !== "paid") throw new TRPCError({ code: "BAD_REQUEST", message: "Apenas lançamentos pagos podem ser conciliados." });
    await db.update(financialTransactions).set({ reconciliationReference: input.reconciliationReference, reconciledAt: new Date(), reconciledByUserId: ctx.user.id }).where(eq(financialTransactions.id, input.id));
    await recordAudit(ctx.user.id, "financial_transaction", input.id, "reconciled", `Lançamento conciliado pela referência ${input.reconciliationReference}.`);
    await recordDomainEvent({ eventName: "financial.entry.reconciled", aggregateType: "financial_transaction", aggregateId: input.id, actorUserId: ctx.user.id, payload: { reconciliationReference: input.reconciliationReference } });
    return { success: true };
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
