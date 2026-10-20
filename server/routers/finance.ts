import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { billingRecords, captureRecords, commercialProjectSettings, contractCancellationRequests, contracts, customers, financialPortfolioAssignments, financialTransactions, financialTransfers, installmentRenegotiations, installments, opportunities, paymentGatewayCustomers, proposals, revenueQualityLedger, salesCampaigns, salesCommissions, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { txAudit, txEvent } from "../txOutbox";
import { protectedProcedure, router } from "../_core/trpc";
import { assertCapability, financeProcedure } from "./access";
import { getCollectionStage } from "../domain";
import { buildCampaignDre } from "../financeDre";
import { isSaleValidated, recordZeroRateSkip } from "../saleValidationService";
import { recordInstallmentSettlementFacts } from "../installmentSettlementFacts";
import { COMMISSION_SKIPPED_MESSAGE, COMMISSION_SKIPPED_REASON, commissionApplies, commissionBlockReason, insertInstallmentCommissions, normalizePaymentMethod, zeroRateSkippedRoles, type CommissionBlockReason, type CreatedCommissionFact } from "../installmentCommissions";
import { parseCompleteCommissionPolicy } from "../projectPolicy";
import { buildRevenueQualityLedger, summarizeRevenueQualityLedger } from "../revenueQualityLedger";
import { syncRevenueQualityForContract } from "../revenueQualitySync";
import { asaasBillingType, billingExternalReference, createAsaasCustomer, createAsaasPayment, findAsaasPaymentsByReference, getAsaasConfig, getAsaasIdentificationField, getAsaasPixQrCode } from "../paymentGateway";
import { affectedRows, isDuplicateKeyError } from "../mysqlErrors";
import { recordInstallmentsScheduled } from "../installmentScheduledFacts";
import { markIssueIntentRecorded, registerIssueIntent } from "../gatewayIssueRecovery";

const dateValue = (value: string) => new Date(`${value}T12:00:00Z`);
const ASAAS_GATEWAY_ERROR = "O gateway de cobrança não respondeu corretamente. Tente novamente.";

async function runAsaas<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new TRPCError({ code: "BAD_GATEWAY", message: ASAAS_GATEWAY_ERROR });
  }
}

export const financeRouter = router({
  portfolioScorecards: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const [assignmentRows, ownerRows] = await Promise.all([
      db.select({
        assignmentId: financialPortfolioAssignments.id,
        ownerUserId: financialPortfolioAssignments.ownerUserId,
        contractId: financialPortfolioAssignments.contractId,
        paidAmountBaseline: financialPortfolioAssignments.paidAmountBaseline,
        startsAt: financialPortfolioAssignments.startsAt,
        openAmount: sql<number>`coalesce(sum(case when ${installments.status} not in ('paid', 'cancelled') then greatest(${installments.amount} - ${installments.paidAmount}, 0) else 0 end), 0)`,
        overdueAmount: sql<number>`coalesce(sum(case when ${installments.status} = 'overdue' then greatest(${installments.amount} - ${installments.paidAmount}, 0) else 0 end), 0)`,
        currentPaidAmount: sql<number>`coalesce(sum(${installments.paidAmount}), 0)`,
      }).from(financialPortfolioAssignments)
        .leftJoin(installments, eq(financialPortfolioAssignments.contractId, installments.contractId))
        .where(isNull(financialPortfolioAssignments.endsAt))
        .groupBy(
          financialPortfolioAssignments.id,
          financialPortfolioAssignments.ownerUserId,
          financialPortfolioAssignments.contractId,
          financialPortfolioAssignments.paidAmountBaseline,
          financialPortfolioAssignments.startsAt,
        ),
      db.select({ id: users.id, name: users.name, email: users.email }).from(users).limit(1000),
    ]);
    const names = new Map(ownerRows.map(owner => [owner.id, owner.name || owner.email || `Usuário #${owner.id}`]));
    const byOwner = new Map<number, { assignedContracts: number; openAmount: number; overdueAmount: number; recoveredAfterAssignment: number; assignedSince: Date | null }>();
    for (const assignment of assignmentRows) {
      const current = byOwner.get(assignment.ownerUserId) ?? { assignedContracts: 0, openAmount: 0, overdueAmount: 0, recoveredAfterAssignment: 0, assignedSince: null };
      const currentPaid = Number(assignment.currentPaidAmount ?? 0);
      const baseline = Number(assignment.paidAmountBaseline ?? 0);
      current.assignedContracts += 1;
      current.openAmount += Number(assignment.openAmount ?? 0);
      current.overdueAmount += Number(assignment.overdueAmount ?? 0);
      current.recoveredAfterAssignment += Math.max(0, currentPaid - baseline);
      const startsAt = assignment.startsAt ? new Date(assignment.startsAt) : null;
      if (startsAt && (!current.assignedSince || startsAt < current.assignedSince)) current.assignedSince = startsAt;
      byOwner.set(assignment.ownerUserId, current);
    }
    return Array.from(byOwner.entries()).map(([ownerUserId, scorecard]) => {
      const openAmount = scorecard.openAmount;
      const overdueAmount = scorecard.overdueAmount;
      const recoveredAfterAssignment = scorecard.recoveredAfterAssignment;
      const regularizationBase = recoveredAfterAssignment + openAmount;
      return {
        ownerUserId,
        ownerName: names.get(ownerUserId) || `Usuário #${ownerUserId}`,
        assignedContracts: scorecard.assignedContracts,
        openAmount: Number(openAmount.toFixed(2)),
        overdueAmount: Number(overdueAmount.toFixed(2)),
        recoveredAfterAssignment: Number(recoveredAfterAssignment.toFixed(2)),
        regularizationRate: regularizationBase ? Number((recoveredAfterAssignment / regularizationBase * 100).toFixed(2)) : null,
        assignedSince: scorecard.assignedSince,
      };
    });
  }),

  portfolioCandidates: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 500;
    const rawRows = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(inArray(users.role, ["admin", "finance"])).orderBy(users.name).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["responsáveis financeiros"] : [] };
  }),

  portfolioAssignments: financeProcedure.input(z.object({ contractId: z.number().int().positive().optional() }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ assignment: financialPortfolioAssignments, contractNumber: contracts.number, ownerName: users.name, ownerEmail: users.email }).from(financialPortfolioAssignments).innerJoin(contracts, eq(financialPortfolioAssignments.contractId, contracts.id)).innerJoin(users, eq(financialPortfolioAssignments.ownerUserId, users.id)).where(and(input?.contractId ? eq(financialPortfolioAssignments.contractId, input.contractId) : undefined, isNull(financialPortfolioAssignments.endsAt))).orderBy(desc(financialPortfolioAssignments.startsAt)).limit(1000);
  }),

  assignPortfolioOwner: financeProcedure.input(z.object({ contractId: z.number().int().positive(), ownerUserId: z.number().int().positive(), notes: z.string().trim().max(2000).optional().nullable() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const contract = (await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
    if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
    const owner = (await db.select({ id: users.id }).from(users).where(and(eq(users.id, input.ownerUserId), inArray(users.role, ["admin", "finance"]))).limit(1))[0];
    if (!owner) throw new TRPCError({ code: "NOT_FOUND", message: "Responsável financeiro não encontrado." });
    const now = new Date();
    const assignmentId = await db.transaction(async tx => {
      const lockedContract = (await tx.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
      if (!lockedContract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
      const [paidSnapshot] = await tx.select({
        paidAmountBaseline: sql<number>`coalesce(sum(${installments.paidAmount}), 0)`,
      }).from(installments).where(eq(installments.contractId, input.contractId));
      const paidAmountBaseline = Number(paidSnapshot?.paidAmountBaseline ?? 0).toFixed(2);
      await tx.update(financialPortfolioAssignments).set({ endsAt: now }).where(and(eq(financialPortfolioAssignments.contractId, input.contractId), isNull(financialPortfolioAssignments.endsAt)));
      const created = await tx.insert(financialPortfolioAssignments).values({ contractId: input.contractId, ownerUserId: input.ownerUserId, assignedByUserId: ctx.user.id, paidAmountBaseline, startsAt: now, notes: input.notes || null }).$returningId();
      const newId = created[0]?.id;
      if (!newId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível atribuir a carteira financeira." });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "financial_portfolio_assignment", entityId: newId, action: "assigned", summary: `Carteira do contrato ${input.contractId} atribuída ao usuário ${input.ownerUserId}.` });
      await txEvent(tx, { eventName: "financial.portfolio.assigned", aggregateType: "financial_portfolio_assignment", aggregateId: newId, actorUserId: ctx.user.id, payload: { contractId: input.contractId, ownerUserId: input.ownerUserId } });
      return newId;
    });
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
    const installmentsByContractId = new Map<number, typeof installmentRows>();
    for (const row of installmentRows) installmentsByContractId.set(row.contractId, [...(installmentsByContractId.get(row.contractId) || []), row]);
    const commissionsByContractId = new Map<number, typeof commissionRows>();
    for (const row of commissionRows) {
      if (row.contractId === null) continue;
      commissionsByContractId.set(row.contractId, [...(commissionsByContractId.get(row.contractId) || []), row]);
    }
    const latestCancellationByContractId = new Map<number, typeof cancellationRows[number]>();
    for (const row of cancellationRows) {
      const current = latestCancellationByContractId.get(row.contractId);
      if (!current || row.createdAt.getTime() > current.createdAt.getTime()) latestCancellationByContractId.set(row.contractId, row);
    }
    return contractRows.map(contract => {
      const cancellation = latestCancellationByContractId.get(contract.id);
      const facts = buildRevenueQualityLedger({
        contract: { id: contract.id, totalAmount: contract.totalAmount, status: contract.status },
        installments: (installmentsByContractId.get(contract.id) || []).map(row => ({ id: row.id, sequence: row.sequence, amount: row.amount, paidAmount: row.paidAmount, status: row.status })),
        commissions: (commissionsByContractId.get(contract.id) || []).map(row => ({ id: row.id, amount: row.amount, status: row.status, lifecycleStatus: row.lifecycleStatus, sourceInstallmentId: row.sourceInstallmentId })),
        cancellation: cancellation ? { status: cancellation.status } : null,
        policyVersion: "tgr-derived-ledger/v1",
      });
      return { contractId: contract.id, contractNumber: contract.number, policyVersion: "tgr-derived-ledger/v1", summary: summarizeRevenueQualityLedger(facts), facts };
    });
  }),

  syncRevenueQualityLedger: financeProcedure.input(z.object({ contractId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    try {
      return await syncRevenueQualityForContract({ contractId: input.contractId, actorUserId: ctx.user.id, trigger: "sincronização manual" });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível sincronizar o ledger." });
    }
  }),

  installments: financeProcedure.input(z.object({ status: z.enum(["open", "overdue", "paid", "cancelled"]).optional(), limit: z.number().int().min(1).max(1000).default(300) }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = input?.limit ?? 300;
    const rawRows = await db.select({ installment: installments, contractNumber: contracts.number, customerName: customers.fullName })
      .from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id))
      .where(input?.status ? eq(installments.status, input.status) : undefined)
      .orderBy(desc(installments.dueDate)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["recebíveis"] : [] };
  }),

  collectionQueue: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const now = new Date();
    const limit = 120;
    const rawRows = await db.select({ installment: installments, contractNumber: contracts.number, customerName: customers.fullName })
      .from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id))
      .where(inArray(installments.status, ["open", "overdue"]))
      .orderBy(installments.dueDate).limit(limit + 1);
    const truncated = rawRows.length > limit;
    const rows = rawRows.slice(0, limit).map(item => {
      const dueDate = new Date(item.installment.dueDate);
      const collection = getCollectionStage(dueDate, now);
      return { ...item, collection, daysPastDue: Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000)) };
    });
    return { rows, truncated, truncatedSources: truncated ? ["fila de cobrança"] : [] };
  }),

  billing: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 300;
    const rawRows = await db.select({ billing: billingRecords, installmentSequence: installments.sequence, contractNumber: contracts.number, customerName: customers.fullName })
      .from(billingRecords).innerJoin(installments, eq(billingRecords.installmentId, installments.id)).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id))
      .orderBy(desc(billingRecords.createdAt)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["cobranças"] : [] };
  }),

  gatewayStatus: financeProcedure.query(() => {
    const config = getAsaasConfig();
    return { provider: "asaas" as const, configured: Boolean(config), baseUrl: config?.baseUrl || null, webhookConfigured: Boolean(config?.webhookToken) };
  }),

  simulateRenegotiation: financeProcedure.input(z.object({ installmentId: z.number().int().positive(), proposedAmount: z.coerce.number().positive(), proposedDueDate: z.string().date() })).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const installment = (await db.select().from(installments).where(eq(installments.id, input.installmentId)).limit(1))[0]; if (!installment) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
    if (["paid", "cancelled", "renegotiated"].includes(installment.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "Esta parcela não pode ser renegociada." });
    const originalAmount = Number((Number(installment.amount) - Number(installment.paidAmount ?? 0)).toFixed(2)); if (originalAmount <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Esta parcela não possui saldo aberto para renegociação." }); if (input.proposedAmount > originalAmount) throw new TRPCError({ code: "BAD_REQUEST", message: "O acordo não pode aumentar o saldo aberto da parcela." });
    return { contractId: installment.contractId, originalAmount, proposedAmount: input.proposedAmount, discountAmount: Number((originalAmount - input.proposedAmount).toFixed(2)), proposedDueDate: input.proposedDueDate };
  }),

  createRenegotiation: financeProcedure.input(z.object({ installmentId: z.number().int().positive(), proposedAmount: z.coerce.number().positive(), proposedDueDate: z.string().date(), notes: z.string().trim().max(2000).nullable().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const renegotiation = await db.transaction(async tx => {
      const installment = (await tx.select().from(installments).where(eq(installments.id, input.installmentId)).limit(1).for("update"))[0];
      if (!installment) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
      const originalAmount = Number((Number(installment.amount) - Number(installment.paidAmount ?? 0)).toFixed(2));
      if (["paid", "cancelled", "renegotiated"].includes(installment.status) || originalAmount <= 0 || input.proposedAmount > originalAmount) throw new TRPCError({ code: "BAD_REQUEST", message: "Acordo inválido para o saldo aberto desta parcela." });
      const active = (await tx.select({ id: installmentRenegotiations.id }).from(installmentRenegotiations).where(and(eq(installmentRenegotiations.originalInstallmentId, input.installmentId), inArray(installmentRenegotiations.status, ["draft", "approved", "applied"]))).limit(1))[0];
      if (active) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma renegociação ativa para esta parcela." });
      const created = await tx.insert(installmentRenegotiations).values({ contractId: installment.contractId, originalInstallmentId: installment.id, originalAmount: originalAmount.toFixed(2), proposedAmount: input.proposedAmount.toFixed(2), proposedDueDate: dateValue(input.proposedDueDate), discountAmount: (originalAmount - input.proposedAmount).toFixed(2), notes: input.notes || null, createdByUserId: ctx.user.id }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o acordo." });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "installment_renegotiation", entityId: id, action: "created", summary: `Acordo proposto para parcela ${installment.sequence}.` });
      await txEvent(tx, { eventName: "installment.renegotiation.proposed", aggregateType: "installment_renegotiation", aggregateId: id, actorUserId: ctx.user.id, payload: { installmentId: installment.id, proposalAmount: input.proposedAmount } });
      return { id };
    });
    return { id: renegotiation.id };
  }),

  // CRM-A11: quem dispara a renegociação. Antes só existia a proposta (draft); nada aprovava nem aplicava. Fluxo: draft -> approved -> applied.
  // Regra da empresa vira configuração com padrão: quem propõe não aprova (RENEGOTIATION_SELF_APPROVAL=true libera, p.ex. operação de uma pessoa só).
  // CRM-A11: lista de acordos para a tela (sem ID opaco). `canApprove` já vem resolvido: quem propôs não aprova, salvo RENEGOTIATION_SELF_APPROVAL=true.
  listRenegotiations: financeProcedure.input(z.object({ contractId: z.number().int().positive().optional(), status: z.enum(["draft", "approved", "applied", "rejected", "cancelled"]).optional(), limit: z.number().int().min(1).max(200).default(100) }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const filters = [input?.contractId ? eq(installmentRenegotiations.contractId, input.contractId) : undefined, input?.status ? eq(installmentRenegotiations.status, input.status) : undefined].filter((item): item is NonNullable<typeof item> => Boolean(item));
    const rows = await db.select({ renegotiation: installmentRenegotiations, sequence: installments.sequence, contractNumber: contracts.number, customerName: customers.fullName })
      .from(installmentRenegotiations).innerJoin(installments, eq(installmentRenegotiations.originalInstallmentId, installments.id)).innerJoin(contracts, eq(installmentRenegotiations.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id))
      .where(filters.length ? and(...filters) : undefined).orderBy(desc(installmentRenegotiations.createdAt), desc(installmentRenegotiations.id)).limit(input?.limit ?? 100);
    const selfApproval = process.env.RENEGOTIATION_SELF_APPROVAL === "true";
    return { rows: rows.map(row => ({ ...row.renegotiation, installmentSequence: row.sequence, contractNumber: row.contractNumber, customerName: row.customerName, canApprove: row.renegotiation.status === "draft" && (selfApproval || row.renegotiation.createdByUserId !== ctx.user.id) })) };
  }),

  approveRenegotiation: financeProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.transaction(async tx => {
      const row = (await tx.select().from(installmentRenegotiations).where(eq(installmentRenegotiations.id, input.id)).limit(1).for("update"))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Acordo não encontrado." });
      if (row.status !== "draft") throw new TRPCError({ code: "CONFLICT", message: "Só um acordo em rascunho pode ser aprovado." });
      if (row.createdByUserId === ctx.user.id && process.env.RENEGOTIATION_SELF_APPROVAL !== "true") throw new TRPCError({ code: "FORBIDDEN", message: "Quem propôs o acordo não pode aprová-lo." });
      await tx.update(installmentRenegotiations).set({ status: "approved", approvedByUserId: ctx.user.id }).where(eq(installmentRenegotiations.id, row.id));
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "installment_renegotiation", entityId: row.id, action: "approved", summary: `Acordo da parcela ${row.originalInstallmentId} aprovado.` });
      await txEvent(tx, { eventName: "installment.renegotiation.approved", aggregateType: "installment_renegotiation", aggregateId: row.id, actorUserId: ctx.user.id, payload: { installmentId: row.originalInstallmentId, proposalAmount: Number(row.proposedAmount) } });
    });
    return { id: input.id, status: "approved" as const };
  }),

  cancelRenegotiation: financeProcedure.input(z.object({ id: z.number().int().positive(), reject: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const status = input.reject ? "rejected" as const : "cancelled" as const;
    await db.transaction(async tx => {
      const row = (await tx.select().from(installmentRenegotiations).where(eq(installmentRenegotiations.id, input.id)).limit(1).for("update"))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Acordo não encontrado." });
      if (!["draft", "approved"].includes(row.status)) throw new TRPCError({ code: "CONFLICT", message: "Só um acordo em rascunho ou aprovado pode ser encerrado." });
      await tx.update(installmentRenegotiations).set({ status }).where(eq(installmentRenegotiations.id, row.id));
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "installment_renegotiation", entityId: row.id, action: status, summary: `Acordo da parcela ${row.originalInstallmentId} ${input.reject ? "rejeitado" : "cancelado"}.` });
    });
    return { id: input.id, status };
  }),

  applyRenegotiation: financeProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    return db.transaction(async tx => {
      const row = (await tx.select().from(installmentRenegotiations).where(eq(installmentRenegotiations.id, input.id)).limit(1).for("update"))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Acordo não encontrado." });
      if (row.status !== "approved") throw new TRPCError({ code: "CONFLICT", message: "Só um acordo aprovado pode ser aplicado." });
      const original = (await tx.select().from(installments).where(eq(installments.id, row.originalInstallmentId)).limit(1).for("update"))[0];
      if (!original) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela original não encontrada." });
      if (!["open", "overdue"].includes(original.status)) throw new TRPCError({ code: "CONFLICT", message: "A parcela original não está mais em aberto; o acordo não pode ser aplicado." });
      const outstanding = Number((Number(original.amount) - Number(original.paidAmount ?? 0)).toFixed(2));
      if (outstanding.toFixed(2) !== Number(row.originalAmount).toFixed(2)) throw new TRPCError({ code: "CONFLICT", message: "O saldo da parcela mudou depois da proposta; crie um novo acordo." });
      const contract = (await tx.select({ id: contracts.id, status: contracts.status }).from(contracts).where(eq(contracts.id, row.contractId)).limit(1).for("update"))[0];
      if (!contract || ["cancelled", "closed"].includes(contract.status)) throw new TRPCError({ code: "CONFLICT", message: "O contrato não aceita renegociação." });
      const last = (await tx.select({ sequence: sql<number>`MAX(${installments.sequence})` }).from(installments).where(eq(installments.contractId, row.contractId)))[0];
      const sequence = Number(last?.sequence ?? 0) + 1;
      await tx.update(installments).set({ status: "renegotiated" }).where(eq(installments.id, original.id));
      const created = await tx.insert(installments).values({ contractId: row.contractId, sequence, dueDate: row.proposedDueDate, amount: Number(row.proposedAmount).toFixed(2), paidAmount: "0.00", status: "open" }).$returningId();
      const newInstallmentId = created[0]?.id;
      if (!newInstallmentId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a nova parcela do acordo." });
      // Cobranças ainda em aberto da parcela original deixam de valer. A cobrança remota do Asaas NÃO é cancelada aqui (o CRM não é dono dela):
      // os ids vão no evento para quem opera o gateway cancelar.
      const openBillings = await tx.select({ id: billingRecords.id, gatewayPaymentId: billingRecords.gatewayPaymentId }).from(billingRecords).where(and(eq(billingRecords.installmentId, original.id), inArray(billingRecords.status, ["pending", "generated"]))).for("update");
      if (openBillings.length) await tx.update(billingRecords).set({ status: "cancelled" }).where(inArray(billingRecords.id, openBillings.map(item => item.id)));
      await tx.update(installmentRenegotiations).set({ status: "applied", appliedAt: new Date() }).where(eq(installmentRenegotiations.id, row.id));
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "installment_renegotiation", entityId: row.id, action: "applied", summary: `Acordo aplicado: parcela ${original.sequence} renegociada na parcela ${sequence}.` });
      await txEvent(tx, { eventName: "installment.renegotiation.applied", aggregateType: "installment_renegotiation", aggregateId: row.id, actorUserId: ctx.user.id, payload: { installmentId: original.id, newInstallmentId, contractId: row.contractId, proposalAmount: Number(row.proposedAmount), cancelledBillingIds: openBillings.map(item => item.id), gatewayPaymentIds: openBillings.map(item => item.gatewayPaymentId).filter((id): id is string => Boolean(id)) }, idempotencyKey: `installment-renegotiation-applied:${row.id}` });
      await recordInstallmentsScheduled(tx, { contractId: row.contractId, actorUserId: ctx.user.id, onlyIds: [newInstallmentId], transition: `reneg-${row.id}` });
      return { id: row.id, status: "applied" as const, originalInstallmentId: original.id, newInstallmentId, cancelledBillingIds: openBillings.map(item => item.id) };
    });
  }),

  issueGatewayBilling: financeProcedure.input(z.object({ installmentId: z.number().int().positive(), type: z.enum(["boleto", "pix"]) }))
    .mutation(async ({ ctx, input }) => {
      const config = getAsaasConfig();
      if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Gateway Asaas não configurado. Defina ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN antes de emitir." });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      let issued;
      try {
        issued = await db.transaction(async tx => {
        const row = (await tx.select({ installment: installments, contract: contracts, customer: customers }).from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id)).where(eq(installments.id, input.installmentId)).limit(1).for("update"))[0];
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
        if (["paid", "cancelled", "renegotiated"].includes(row.installment.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "Não é possível emitir cobrança para uma parcela paga, cancelada ou renegociada." });
        const existing = (await tx.select({ billing: billingRecords }).from(billingRecords).where(and(eq(billingRecords.installmentId, input.installmentId), eq(billingRecords.gatewayProvider, "asaas"), inArray(billingRecords.status, ["pending", "generated", "paid"]))).orderBy(desc(billingRecords.createdAt)).limit(1))[0];
        if (existing?.billing.gatewayPaymentId) {
          if (existing.billing.type !== input.type) throw new TRPCError({ code: "CONFLICT", message: `Já existe uma cobrança Asaas do tipo ${existing.billing.type} para esta parcela.` });
          return { id: existing.billing.id, gatewayPaymentId: existing.billing.gatewayPaymentId, reused: true };
        }

        const cpfCnpj = (row.customer.documentNumber || "").replace(/\\D/g, "");
        if (![11, 14].includes(cpfCnpj.length)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Cadastre um CPF ou CNPJ válido no associado antes de emitir a cobrança." });
        const externalCustomerReference = `TGR-CRM-CUSTOMER-${row.customer.id}`;
        const customerLock = (await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, row.customer.id)).limit(1).for("update"))[0];
        if (!customerLock) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente da cobrança não encontrado." });
        let gatewayCustomerId = (await tx.select({ gatewayCustomerId: paymentGatewayCustomers.gatewayCustomerId }).from(paymentGatewayCustomers).where(and(eq(paymentGatewayCustomers.customerId, row.customer.id), eq(paymentGatewayCustomers.gatewayProvider, "asaas"))).limit(1))[0]?.gatewayCustomerId;
        if (!gatewayCustomerId) {
          const remoteCustomer = await runAsaas(() => createAsaasCustomer(config, { name: row.customer.fullName, email: row.customer.email || null, mobilePhone: row.customer.phone || null, cpfCnpj, externalReference: externalCustomerReference }));
          gatewayCustomerId = remoteCustomer.id;
          await tx.insert(paymentGatewayCustomers).values({ customerId: row.customer.id, gatewayProvider: "asaas", gatewayCustomerId }).onDuplicateKeyUpdate({ set: { gatewayCustomerId, updatedAt: new Date() } });
        }

        const outstandingAmount = Number((Number(row.installment.amount) - Number(row.installment.paidAmount ?? 0)).toFixed(2));
        if (outstandingAmount <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "A parcela não possui saldo aberto para cobrança." });
        const externalReference = billingExternalReference(input.installmentId);
        const expectedBillingType = asaasBillingType(input.type);
        const existingRemote = (await runAsaas(() => findAsaasPaymentsByReference(config, externalReference))).data?.find(item => item.externalReference === externalReference && item.billingType === expectedBillingType);
        // CRM-A10: a intenção é gravada (fora desta transação) antes da chamada remota que cria a cobrança.
        if (!existingRemote) await runAsaas(() => registerIssueIntent(db, { installmentId: input.installmentId, type: input.type, externalReference, actorUserId: ctx.user.id }));
        const payment = existingRemote || await runAsaas(() => createAsaasPayment(config, { customer: gatewayCustomerId, billingType: expectedBillingType, value: outstandingAmount, dueDate: new Date(row.installment.dueDate).toISOString().slice(0, 10), description: `TGR-CRM · ${row.contract.number} · parcela ${row.installment.sequence}`, externalReference }));
        const identification = input.type === "boleto" ? await runAsaas(() => getAsaasIdentificationField(config, payment.id)) : null;
        const pix = input.type === "pix" ? await runAsaas(() => getAsaasPixQrCode(config, payment.id)) : null;
        const created = await tx.insert(billingRecords).values({ installmentId: input.installmentId, type: input.type, status: "generated", gatewayProvider: "asaas", gatewayPaymentId: payment.id, gatewayStatus: payment.status || "PENDING", amount: outstandingAmount.toFixed(2), dueDate: row.installment.dueDate, externalReference, digitableLine: identification?.identificationField || null, pixCopyPaste: pix?.payload || null, pixQrCodeBase64: pix?.encodedImage || null, invoiceUrl: payment.invoiceUrl || null, bankSlipUrl: payment.bankSlipUrl || null, generatedAt: new Date() }).$returningId();
        const id = created[0]?.id;
        if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Cobrança criada no gateway, mas não foi persistida no CRM." });
        await markIssueIntentRecorded(tx, { installmentId: input.installmentId, type: input.type, gatewayPaymentId: payment.id });
          await txAudit(tx, { actorUserId: ctx.user.id, entityType: "billing_record", entityId: id, action: "gateway_issued", summary: `Cobrança ${input.type.toUpperCase()} emitida pelo Asaas para parcela ${input.installmentId}.` });
          await txEvent(tx, { eventName: "financial.billing.created", aggregateType: "billing_record", aggregateId: id, actorUserId: ctx.user.id, payload: { installmentId: input.installmentId, gatewayProvider: "asaas", gatewayPaymentId: payment.id, type: input.type } });
          return { id, gatewayPaymentId: payment.id, reused: false };
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "A cobrança foi processada, mas não foi possível confirmar o estado no CRM." });
      }
      return issued;
    }),

  registerBilling: financeProcedure.input(z.object({ idempotencyKey: z.string().trim().min(16).max(128).optional(), installmentId: z.number().int().positive(), type: z.enum(["boleto", "pix", "card", "transfer"]), amount: z.coerce.number().positive(), dueDate: z.string().date(), externalReference: z.string().trim().max(255).optional().nullable(), digitableLine: z.string().trim().max(255).optional().nullable(), pixCopyPaste: z.string().trim().max(4000).optional().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (["boleto", "pix"].includes(input.type)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PIX e boleto precisam ser emitidos pelo gateway configurado; o registro manual foi bloqueado para evitar cobrança fictícia." });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const expectedAmount = input.amount.toFixed(2);
      const expectedDueDate = dateValue(input.dueDate);
      const externalReference = input.externalReference?.trim() || `TGR-${input.installmentId}-${input.idempotencyKey ?? Date.now()}`;
      const matchesExisting = (existing: { installmentId: number; type: string; amount: string; dueDate: Date; externalReference: string | null }) => existing.installmentId === input.installmentId && existing.type === input.type && existing.amount === expectedAmount && existing.dueDate.getTime() === expectedDueDate.getTime() && existing.externalReference === externalReference;
      let created: { id: number; reused?: boolean };
      try {
        created = await db.transaction(async tx => {
          if (input.idempotencyKey) {
            const existing = (await tx.select({ billing: billingRecords }).from(billingRecords).where(eq(billingRecords.idempotencyKey, input.idempotencyKey)).limit(1))[0]?.billing;
            if (existing) {
              if (!matchesExisting(existing)) throw new TRPCError({ code: "CONFLICT", message: "A chave idempotente já foi usada para outra cobrança." });
              return { id: existing.id, reused: true };
            }
          }
          const installment = (await tx.select({ id: installments.id, status: installments.status, amount: installments.amount, paidAmount: installments.paidAmount, dueDate: installments.dueDate }).from(installments).where(eq(installments.id, input.installmentId)).limit(1).for("update"))[0];
          if (!installment) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela da cobrança não encontrada." });
          if (["paid", "cancelled", "renegotiated"].includes(installment.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "Não é possível registrar cobrança para uma parcela paga, cancelada ou renegociada." });
          const outstandingAmount = Number((Number(installment.amount) - Number(installment.paidAmount ?? 0)).toFixed(2)).toFixed(2); if (outstandingAmount !== expectedAmount || installment.dueDate.getTime() !== expectedDueDate.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "Valor e vencimento da cobrança devem coincidir com o saldo aberto da parcela." });
          const duplicateReference = (await tx.select({ id: billingRecords.id }).from(billingRecords).where(and(eq(billingRecords.gatewayProvider, "manual"), eq(billingRecords.externalReference, externalReference))).limit(1))[0];
          if (duplicateReference) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma cobrança manual com esta referência externa." });
          const activeDuplicate = (await tx.select({ id: billingRecords.id }).from(billingRecords).where(and(eq(billingRecords.installmentId, input.installmentId), eq(billingRecords.type, input.type), eq(billingRecords.gatewayProvider, "manual"), inArray(billingRecords.status, ["pending", "generated", "paid"]))).limit(1))[0];
          if (activeDuplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma cobrança manual ativa para esta parcela e tipo." });
          const inserted = await tx.insert(billingRecords).values({ idempotencyKey: input.idempotencyKey ?? null, installmentId: input.installmentId, type: input.type, gatewayProvider: "manual", amount: expectedAmount, dueDate: expectedDueDate, externalReference, digitableLine: null, pixCopyPaste: null, status: "generated", generatedAt: new Date() }).$returningId();
          const id = inserted[0]?.id;
          if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar a cobrança." });
          await txAudit(tx, { actorUserId: ctx.user.id, entityType: "billing_record", entityId: id, action: "registered", summary: `Cobrança ${input.type} registrada.` });
          await txEvent(tx, { eventName: "financial.billing.created", aggregateType: "billing_record", aggregateId: id, actorUserId: ctx.user.id, payload: { installmentId: input.installmentId, gatewayProvider: "manual", gatewayPaymentId: null, type: input.type } });
          return { id, reused: false };
        });
      } catch (error) {
        if (!input.idempotencyKey || !isDuplicateKeyError(error)) throw error;
        const existing = (await db.select({ billing: billingRecords }).from(billingRecords).where(eq(billingRecords.idempotencyKey, input.idempotencyKey)).limit(1))[0]?.billing;
        if (!existing) throw new TRPCError({ code: "CONFLICT", message: "A cobrança foi criada por outra operação. Recarregue a tela." });
        if (!matchesExisting(existing)) throw new TRPCError({ code: "CONFLICT", message: "A chave idempotente já foi usada para outra cobrança." });
        created = { id: existing.id, reused: true };
      }
      if (created.reused) return created;
      return { id: created.id };
    }),

  markInstallmentPaid: financeProcedure.input(z.object({ id: z.number().int().positive(), paymentMethod: z.string().trim().max(64).optional().nullable() }))
    .mutation(async ({ ctx, input }) => {
      assertCapability(ctx.user.role, "finance.installment.settle", "Somente financeiro pode baixar parcelas.");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const item = (await db.select().from(installments).where(eq(installments.id, input.id)).limit(1))[0];
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
      if (item.status === "paid") return { success: true, alreadyPaid: true, commissionBlocked: false };
      if (!["open", "overdue"].includes(item.status)) throw new TRPCError({ code: "CONFLICT", message: "A parcela não está em estado elegível para baixa." });
      const contract = (await db.select().from(contracts).where(eq(contracts.id, item.contractId)).limit(1))[0] ?? null;
      const proposal = contract?.proposalId ? ((await db.select().from(proposals).where(eq(proposals.id, contract.proposalId)).limit(1))[0] ?? null) : null;
      const opportunity = proposal?.opportunityId ? ((await db.select().from(opportunities).where(eq(opportunities.id, proposal.opportunityId)).limit(1))[0] ?? null) : null;
      const capture = opportunity?.id ? ((await db.select().from(captureRecords).where(eq(captureRecords.opportunityId, opportunity.id)).orderBy(desc(captureRecords.createdAt)).limit(1))[0] ?? null) : null;
      const commissionContext = contract ? { contract, proposal, opportunity, capture } : null;
      // ADR-007: a validação da venda é lida DENTRO da transação, depois da trava do contrato (mesma ordem de trava da validação final).
      const policyRow = commissionContext?.capture?.resortId ? (await db.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, commissionContext.capture.resortId)).limit(1))[0] : null; const commissionPolicy = parseCompleteCommissionPolicy(policyRow?.commissionPolicy); const commissionNeedsPolicy = commissionApplies(commissionContext);
      let blockedReason: CommissionBlockReason | null = null;
      const createdCommissionFacts: CreatedCommissionFact[] = [];
      const settled = await db.transaction(async tx => {
        // Trava o contrato ANTES da parcela (mesma ordem do distrato e da validação final): a decisão do gate de comissão não corre contra a validação.
        const lockedContract = (await tx.select({ id: contracts.id, status: contracts.status }).from(contracts).where(eq(contracts.id, item.contractId)).limit(1).for("update"))[0];
        const lockedItem = (await tx.select({ id: installments.id, status: installments.status, amount: installments.amount, paidAmount: installments.paidAmount }).from(installments).where(eq(installments.id, input.id)).limit(1).for("update"))[0];
        if (!lockedItem) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
        if (lockedItem.status === "paid") return false;
        if (!["open", "overdue"].includes(lockedItem.status)) throw new TRPCError({ code: "CONFLICT", message: "A parcela não está em estado elegível para baixa." });
        const remainingAmount = Number((Number(lockedItem.amount) - Number(lockedItem.paidAmount ?? 0)).toFixed(2));
        if (remainingAmount <= 0) throw new TRPCError({ code: "CONFLICT", message: "A parcela não possui saldo aberto para baixa." });
        const updateResult = await tx.update(installments).set({ status: "paid", paidAmount: Number(lockedItem.amount).toFixed(2), paidAt: new Date(), paymentMethod: input.paymentMethod || null }).where(and(eq(installments.id, input.id), inArray(installments.status, ["open", "overdue"])));
        if (affectedRows(updateResult) === 0) return false;
        await tx.update(billingRecords).set({ status: "paid" }).where(and(eq(billingRecords.installmentId, input.id), inArray(billingRecords.status, ["pending", "generated"])));
        await tx.insert(financialTransactions).values({ contractId: item.contractId, campaignId: null, type: "income", category: "Parcela de contrato", description: `Baixa da parcela ${item.sequence}`, amount: remainingAmount.toFixed(2), dueDate: item.dueDate, paidAt: new Date(), status: "paid", createdByUserId: ctx.user.id });
        if (commissionContext && commissionNeedsPolicy) {
          blockedReason = commissionBlockReason(lockedContract?.status, commissionPolicy, await isSaleValidated(tx, item.contractId));
          // ADR-010: portão passou, mas nenhum papel tem taxa > 0 (janela de 0%): rastreável (auditoria + evento) para reprocesso.
          if (!blockedReason && commissionPolicy) {
            // Issue #38 (2): o registro do skip nasce na MESMA transação da baixa (idempotente por parcela).
            const zeroRoles = zeroRateSkippedRoles(commissionContext.capture, commissionPolicy);
            if (zeroRoles) await recordZeroRateSkip(tx, { installmentId: input.id, contractId: item.contractId, resortId: commissionContext.capture?.resortId ?? null, roles: zeroRoles, actorUserId: ctx.user.id, source: "manual" });
          }
          if (!blockedReason && commissionPolicy) createdCommissionFacts.push(...await insertInstallmentCommissions(tx, { installment: { id: item.id, amount: item.amount, contractId: item.contractId }, context: { contract: { ...commissionContext.contract, status: lockedContract?.status ?? commissionContext.contract.status }, proposal: commissionContext.proposal, opportunity: commissionContext.opportunity, capture: commissionContext.capture }, policy: commissionPolicy, paymentMethod: normalizePaymentMethod(input.paymentMethod), compensatedAt: new Date() }));
        }
        // Issue #43: auditoria e fatos consumidos pelo Financial nascem na MESMA transação da baixa (outbox em domain_events).
        await recordInstallmentSettlementFacts(tx, { installmentId: input.id, contractId: item.contractId, sequence: item.sequence, amount: lockedItem.amount, paidAmount: remainingAmount.toFixed(2), source: "manual", gatewayPaymentId: null, actorUserId: ctx.user.id, blockedReason, createdCommissions: createdCommissionFacts });
        return true;
      });
      if (!settled) return { success: true, alreadyPaid: true, commissionBlocked: false };
      const commissionBlocked = blockedReason !== null;
      await syncRevenueQualityForContract({ contractId: item.contractId, actorUserId: ctx.user.id, trigger: "baixa de parcela" });
      return { success: true, alreadyPaid: false, commissionBlocked };
    }),

  entries: financeProcedure.input(z.object({ type: z.enum(["income", "expense"]).optional(), status: z.enum(["open", "paid", "cancelled"]).optional(), limit: z.number().int().min(1).max(1000).default(300) }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return { rows: [], totals: { income: 0, expense: 0 }, truncated: false };
    const limit = input?.limit ?? 300;
    const filters = and(input?.type ? eq(financialTransactions.type, input.type) : undefined, input?.status ? eq(financialTransactions.status, input.status) : undefined);
    const [rawRows, totalRows] = await Promise.all([
      db.select({ entry: financialTransactions, contractNumber: contracts.number, campaignName: salesCampaigns.name }).from(financialTransactions).leftJoin(contracts, eq(financialTransactions.contractId, contracts.id)).leftJoin(salesCampaigns, eq(financialTransactions.campaignId, salesCampaigns.id)).where(filters).orderBy(desc(financialTransactions.createdAt)).limit(limit + 1),
      db.select({ income: sql<string>`coalesce(sum(case when ${financialTransactions.type} = 'income' then ${financialTransactions.amount} else 0 end), 0)`, expense: sql<string>`coalesce(sum(case when ${financialTransactions.type} = 'expense' then ${financialTransactions.amount} else 0 end), 0)` }).from(financialTransactions).where(filters).limit(1),
    ]);
    const totals = totalRows[0] ?? { income: "0", expense: "0" };
    return { rows: rawRows.slice(0, limit), totals: { income: Number(Number(totals.income).toFixed(2)), expense: Number(Number(totals.expense).toFixed(2)) }, truncated: rawRows.length > limit };
  }),

  campaigns: financeProcedure.query(async () => {
    const db = await getDb(); if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 200;
    const rawRows = await db.select({ id: salesCampaigns.id, name: salesCampaigns.name, code: salesCampaigns.code, status: salesCampaigns.status }).from(salesCampaigns).orderBy(salesCampaigns.name).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["campanhas financeiras"] : [] };
  }),

  dreByCampaign: financeProcedure.input(z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).optional()).query(async ({ input }) => {
    const db = await getDb(); if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 1000;
    const transactions = await db.select({
      campaignId: sql<number | null>`coalesce(${financialTransactions.campaignId}, ${opportunities.campaignId})`,
      campaignName: salesCampaigns.name,
      type: financialTransactions.type,
      amount: sql<string>`coalesce(sum(${financialTransactions.amount}), 0)`,
    }).from(financialTransactions)
      .leftJoin(contracts, eq(financialTransactions.contractId, contracts.id))
      .leftJoin(proposals, eq(contracts.proposalId, proposals.id))
      .leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id))
      .leftJoin(salesCampaigns, sql`${salesCampaigns.id} = coalesce(${financialTransactions.campaignId}, ${opportunities.campaignId})`)
      .where(and(eq(financialTransactions.status, "paid"), isNotNull(financialTransactions.paidAt), input?.from ? gte(financialTransactions.paidAt, dateValue(input.from)) : undefined, input?.to ? lte(financialTransactions.paidAt, new Date(`${input.to}T23:59:59Z`)) : undefined))
      .groupBy(sql`coalesce(${financialTransactions.campaignId}, ${opportunities.campaignId})`, salesCampaigns.name, financialTransactions.type)
      .limit(limit + 1);
    const truncated = transactions.length > limit;
    return { rows: buildCampaignDre(transactions.slice(0, limit).map(row => ({ campaignId: row.campaignId, campaignName: row.campaignName, type: row.type, amount: row.amount }))), truncated, truncatedSources: truncated ? ["grupos do DRE"] : [] };
  }),

  createEntry: financeProcedure.input(z.object({ idempotencyKey: z.string().trim().min(16).max(128).optional(), contractId: z.number().int().positive().optional().nullable(), campaignId: z.number().int().positive().optional().nullable(), type: z.enum(["income", "expense"]), category: z.string().trim().min(2).max(120), description: z.string().trim().min(2).max(2000), amount: z.coerce.number().positive(), dueDate: z.string().date().optional().nullable(), status: z.enum(["open", "paid"]).default("open") }))
    .mutation(async ({ ctx, input }) => {
      assertCapability(ctx.user.role, "finance.entry.create");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      if (input.contractId) {
        const contract = (await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
        if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato do lançamento não encontrado." });
      }
      if (input.campaignId) {
        const campaign = (await db.select({ id: salesCampaigns.id }).from(salesCampaigns).where(eq(salesCampaigns.id, input.campaignId)).limit(1))[0];
        if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campanha do lançamento não encontrada." });
      }
      const expectedContractId = input.contractId ?? null;
      const expectedCampaignId = input.campaignId ?? null;
      const expectedAmount = input.amount.toFixed(2);
      const expectedDueDate = input.dueDate ? dateValue(input.dueDate) : null;
      const matchesExisting = (existing: { contractId: number | null; campaignId: number | null; type: "income" | "expense"; category: string; description: string; amount: string; dueDate: Date | null; status: "open" | "paid" | "cancelled" }) => existing.contractId === expectedContractId && existing.campaignId === expectedCampaignId && existing.type === input.type && existing.category === input.category && existing.description === input.description && existing.amount === expectedAmount && (existing.dueDate?.getTime() ?? null) === (expectedDueDate?.getTime() ?? null) && existing.status === input.status;
      if (input.idempotencyKey) {
        const existing = (await db.select({ id: financialTransactions.id, contractId: financialTransactions.contractId, campaignId: financialTransactions.campaignId, type: financialTransactions.type, category: financialTransactions.category, description: financialTransactions.description, amount: financialTransactions.amount, dueDate: financialTransactions.dueDate, status: financialTransactions.status }).from(financialTransactions).where(eq(financialTransactions.idempotencyKey, input.idempotencyKey)).limit(1))[0];
        if (existing) {
          if (!matchesExisting(existing)) throw new TRPCError({ code: "CONFLICT", message: "A chave idempotente já foi usada para outro lançamento." });
          return { id: existing.id, reused: true };
        }
      }
      let created;
      try {
        created = await db.transaction(async tx => {
          const inserted = await tx.insert(financialTransactions).values({ idempotencyKey: input.idempotencyKey ?? null, contractId: expectedContractId, campaignId: expectedCampaignId, type: input.type, category: input.category, description: input.description, amount: expectedAmount, dueDate: expectedDueDate, status: input.status, paidAt: input.status === "paid" ? new Date() : null, createdByUserId: ctx.user.id }).$returningId();
          const newId = inserted[0]?.id;
          if (!newId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o lançamento." });
          await txAudit(tx, { actorUserId: ctx.user.id, entityType: "financial_transaction", entityId: newId, action: "created", summary: `Lançamento ${input.type} criado.` });
          await txEvent(tx, { eventName: "financial.entry.created", aggregateType: "financial_transaction", aggregateId: newId, actorUserId: ctx.user.id, payload: { type: input.type, category: input.category, amount: input.amount, contractId: expectedContractId, campaignId: expectedCampaignId } });
          return inserted;
        });
      } catch (error) {
        if (!input.idempotencyKey || !isDuplicateKeyError(error)) throw error;
        const existing = (await db.select({ id: financialTransactions.id, contractId: financialTransactions.contractId, campaignId: financialTransactions.campaignId, type: financialTransactions.type, category: financialTransactions.category, description: financialTransactions.description, amount: financialTransactions.amount, dueDate: financialTransactions.dueDate, status: financialTransactions.status }).from(financialTransactions).where(eq(financialTransactions.idempotencyKey, input.idempotencyKey)).limit(1))[0];
        if (!existing) throw new TRPCError({ code: "CONFLICT", message: "O lançamento foi criado por outra operação. Recarregue a tela." });
        if (!matchesExisting(existing)) throw new TRPCError({ code: "CONFLICT", message: "A chave idempotente já foi usada para outro lançamento." });
        return { id: existing.id, reused: true };
      }
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o lançamento." });
      return { id, reused: false };
    }),

  reconcileEntry: financeProcedure.input(z.object({ id: z.number().int().positive(), reconciliationReference: z.string().trim().min(3).max(255) })).mutation(async ({ ctx, input }) => {
    assertCapability(ctx.user.role, "finance.payment.reconcile");
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const entry = (await db.select().from(financialTransactions).where(eq(financialTransactions.id, input.id)).limit(1))[0];
    if (!entry) throw new TRPCError({ code: "NOT_FOUND", message: "Lançamento não encontrado." });
    if (entry.status !== "paid") throw new TRPCError({ code: "BAD_REQUEST", message: "Apenas lançamentos pagos podem ser conciliados." });
    if (entry.reconciledAt) {
      if (entry.reconciliationReference === input.reconciliationReference) return { success: true, alreadyReconciled: true };
      throw new TRPCError({ code: "CONFLICT", message: "O lançamento já foi conciliado com outra referência." });
    }
    const reconciledAt = new Date();
    let alreadyReconciled = false;
    await db.transaction(async tx => {
      const updateResult = await tx.update(financialTransactions).set({ reconciliationReference: input.reconciliationReference, reconciledAt, reconciledByUserId: ctx.user.id }).where(and(eq(financialTransactions.id, input.id), isNull(financialTransactions.reconciledAt)));
      if (affectedRows(updateResult) === 0) {
        const latest = (await tx.select({ reconciliationReference: financialTransactions.reconciliationReference }).from(financialTransactions).where(eq(financialTransactions.id, input.id)).limit(1))[0];
        if (latest?.reconciliationReference === input.reconciliationReference) { alreadyReconciled = true; return; }
        throw new TRPCError({ code: "CONFLICT", message: "O lançamento foi conciliado por outra operação com referência diferente." });
      }
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "financial_transaction", entityId: input.id, action: "reconciled", summary: `Lançamento conciliado pela referência ${input.reconciliationReference}.` });
      await txEvent(tx, { eventName: "financial.entry.reconciled", aggregateType: "financial_transaction", aggregateId: input.id, actorUserId: ctx.user.id, payload: { reference: input.reconciliationReference, reconciledAt } });
    });
    if (alreadyReconciled) return { success: true, alreadyReconciled: true };
    return { success: true };
  }),

  transfers: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 300;
    const rawRows = await db.select({ transfer: financialTransfers, contractNumber: contracts.number }).from(financialTransfers).leftJoin(contracts, eq(financialTransfers.contractId, contracts.id)).orderBy(desc(financialTransfers.dueDate)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["repasses"] : [] };
  }),

  createTransfer: financeProcedure.input(z.object({ idempotencyKey: z.string().trim().min(16).max(128).optional(), contractId: z.number().int().positive().optional().nullable(), beneficiaryName: z.string().trim().min(2).max(255), description: z.string().trim().max(2000).optional().nullable(), amount: z.coerce.number().positive(), dueDate: z.string().date() }))
    .mutation(async ({ ctx, input }) => {
      assertCapability(ctx.user.role, "finance.transfer.create");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      if (input.contractId) {
        const contract = (await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
        if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato do repasse não encontrado." });
      }
      const expectedAmount = input.amount.toFixed(2);
      const expectedDueDate = dateValue(input.dueDate);
      const matchesExisting = (existing: { contractId: number | null; beneficiaryName: string; description: string | null; amount: string; dueDate: Date }) => existing.contractId === (input.contractId ?? null) && existing.beneficiaryName === input.beneficiaryName && existing.description === (input.description || null) && existing.amount === expectedAmount && existing.dueDate.getTime() === expectedDueDate.getTime();
      if (input.idempotencyKey) {
        const existing = (await db.select({ id: financialTransfers.id, contractId: financialTransfers.contractId, beneficiaryName: financialTransfers.beneficiaryName, description: financialTransfers.description, amount: financialTransfers.amount, dueDate: financialTransfers.dueDate }).from(financialTransfers).where(eq(financialTransfers.idempotencyKey, input.idempotencyKey)).limit(1))[0];
        if (existing) {
          if (!matchesExisting(existing)) throw new TRPCError({ code: "CONFLICT", message: "A chave idempotente já foi usada para outro repasse." });
          return { id: existing.id, reused: true };
        }
      }
      let created;
      try {
        created = await db.transaction(async tx => {
          const inserted = await tx.insert(financialTransfers).values({ idempotencyKey: input.idempotencyKey ?? null, contractId: input.contractId ?? null, beneficiaryName: input.beneficiaryName, description: input.description || null, amount: expectedAmount, dueDate: expectedDueDate }).$returningId();
          const newId = inserted[0]?.id;
          if (!newId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar o repasse." });
          await txAudit(tx, { actorUserId: ctx.user.id, entityType: "financial_transfer", entityId: newId, action: "created", summary: `Repasse para ${input.beneficiaryName} registrado.` });
          await txEvent(tx, { eventName: "financial.transfer.created", aggregateType: "financial_transfer", aggregateId: newId, actorUserId: ctx.user.id, payload: { recipient: input.beneficiaryName, amount: input.amount, contractId: input.contractId ?? null } });
          return inserted;
        });
      } catch (error) {
        if (!input.idempotencyKey || !isDuplicateKeyError(error)) throw error;
        const existing = (await db.select({ id: financialTransfers.id, contractId: financialTransfers.contractId, beneficiaryName: financialTransfers.beneficiaryName, description: financialTransfers.description, amount: financialTransfers.amount, dueDate: financialTransfers.dueDate }).from(financialTransfers).where(eq(financialTransfers.idempotencyKey, input.idempotencyKey)).limit(1))[0];
        if (!existing) throw new TRPCError({ code: "CONFLICT", message: "O repasse foi criado por outra operação. Recarregue a tela." });
        if (!matchesExisting(existing)) throw new TRPCError({ code: "CONFLICT", message: "A chave idempotente já foi usada para outro repasse." });
        return { id: existing.id, reused: true };
      }
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar o repasse." });
      return { id, reused: false };
    }),

  markTransferPaid: financeProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    assertCapability(ctx.user.role, "finance.transfer.pay");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const outcome = await db.transaction(async tx => {
      const transfer = (await tx.select({ status: financialTransfers.status, amount: financialTransfers.amount, contractId: financialTransfers.contractId }).from(financialTransfers).where(eq(financialTransfers.id, input.id)).limit(1).for("update"))[0];
      if (!transfer) throw new TRPCError({ code: "NOT_FOUND", message: "Repasse não encontrado." });
      if (transfer.status === "paid") return { success: true, alreadyPaid: true, amount: transfer.amount, contractId: transfer.contractId };
      if (transfer.status === "cancelled") throw new TRPCError({ code: "CONFLICT", message: "Repasse cancelado não pode ser pago." });
      const updateResult = await tx.update(financialTransfers).set({ status: "paid", paidAt: new Date() }).where(and(eq(financialTransfers.id, input.id), eq(financialTransfers.status, "pending")));
      if (affectedRows(updateResult) === 0) return { success: true, alreadyPaid: true };
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "financial_transfer", entityId: input.id, action: "paid", summary: "Repasse baixado como pago." });
      await txEvent(tx, { eventName: "financial.transfer.paid", aggregateType: "financial_transfer", aggregateId: input.id, actorUserId: ctx.user.id, payload: { amount: transfer.amount, contractId: transfer.contractId } });
      return { success: true, alreadyPaid: false, amount: transfer.amount, contractId: transfer.contractId };
    });
    return { success: outcome.success, alreadyPaid: outcome.alreadyPaid };
  }),
});
