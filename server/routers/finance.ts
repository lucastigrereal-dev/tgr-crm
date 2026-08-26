import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { billingRecords, captureRecords, commercialProjectSettings, contractCancellationRequests, contracts, customers, financialPortfolioAssignments, financialTransactions, financialTransfers, installmentRenegotiations, installments, opportunities, paymentGatewayCustomers, proposals, revenueQualityLedger, salesCampaigns, salesCommissions, users } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { assertCapability, financeProcedure } from "./access";
import { getCollectionStage } from "../domain";
import { buildCampaignDre } from "../financeDre";
import { buildInstallmentCommissions } from "../commissionAutomation";
import { parseCompleteCommissionPolicy } from "../projectPolicy";
import { buildRevenueQualityLedger, summarizeRevenueQualityLedger } from "../revenueQualityLedger";
import { syncRevenueQualityForContract } from "../revenueQualitySync";
import { asaasBillingType, billingExternalReference, createAsaasCustomer, createAsaasPayment, findAsaasPaymentsByReference, getAsaasConfig, getAsaasIdentificationField, getAsaasPixQrCode } from "../paymentGateway";

const dateValue = (value: string) => new Date(`${value}T12:00:00Z`);
const ASAAS_GATEWAY_ERROR = "O gateway de cobrança não respondeu corretamente. Tente novamente.";

async function runAsaas<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new TRPCError({ code: "BAD_GATEWAY", message: ASAAS_GATEWAY_ERROR });
  }
}

const isDuplicateKeyError = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && String(error.code) === "ER_DUP_ENTRY");

export const financeRouter = router({
  portfolioScorecards: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const [scorecardRows, ownerRows] = await Promise.all([
      db.select({
        ownerUserId: financialPortfolioAssignments.ownerUserId,
        assignedContracts: sql<number>`count(distinct ${financialPortfolioAssignments.contractId})`,
        openAmount: sql<number>`coalesce(sum(case when ${installments.status} not in ('paid', 'cancelled') then ${installments.amount} else 0 end), 0)`,
        overdueAmount: sql<number>`coalesce(sum(case when ${installments.status} = 'overdue' then ${installments.amount} else 0 end), 0)`,
        recoveredAfterAssignment: sql<number>`coalesce(sum(case when ${installments.status} = 'paid' and ${installments.paidAt} >= ${financialPortfolioAssignments.startsAt} then ${installments.amount} else 0 end), 0)`,
        assignedSince: sql<Date>`min(${financialPortfolioAssignments.startsAt})`,
      }).from(financialPortfolioAssignments).leftJoin(installments, eq(financialPortfolioAssignments.contractId, installments.contractId)).where(isNull(financialPortfolioAssignments.endsAt)).groupBy(financialPortfolioAssignments.ownerUserId),
      db.select({ id: users.id, name: users.name, email: users.email }).from(users).limit(1000),
    ]);
    const names = new Map(ownerRows.map(owner => [owner.id, owner.name || owner.email || `Usuário #${owner.id}`]));
    return scorecardRows.map(scorecard => {
      const openAmount = Number(scorecard.openAmount ?? 0);
      const overdueAmount = Number(scorecard.overdueAmount ?? 0);
      const recoveredAfterAssignment = Number(scorecard.recoveredAfterAssignment ?? 0);
      const regularizationBase = recoveredAfterAssignment + openAmount;
      return {
        ownerUserId: scorecard.ownerUserId,
        ownerName: names.get(scorecard.ownerUserId) || `Usuário #${scorecard.ownerUserId}`,
        assignedContracts: Number(scorecard.assignedContracts ?? 0),
        openAmount: Number(openAmount.toFixed(2)),
        overdueAmount: Number(overdueAmount.toFixed(2)),
        recoveredAfterAssignment: Number(recoveredAfterAssignment.toFixed(2)),
        regularizationRate: regularizationBase ? Number((recoveredAfterAssignment / regularizationBase * 100).toFixed(2)) : null,
        assignedSince: scorecard.assignedSince ? new Date(scorecard.assignedSince) : null,
      };
    });
  }),

  portfolioCandidates: financeProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(inArray(users.role, ["admin", "finance"])).orderBy(users.name).limit(500);
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
    const owner = (await db.select({ id: users.id }).from(users).where(eq(users.id, input.ownerUserId)).limit(1))[0];
    if (!owner) throw new TRPCError({ code: "NOT_FOUND", message: "Responsável financeiro não encontrado." });
    const now = new Date();
    const assignmentId = await db.transaction(async tx => {
      const lockedContract = (await tx.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
      if (!lockedContract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
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
        installments: (installmentsByContractId.get(contract.id) || []).map(row => ({ id: row.id, sequence: row.sequence, amount: row.amount, status: row.status })),
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
    const originalAmount = Number(installment.amount); if (input.proposedAmount > originalAmount) throw new TRPCError({ code: "BAD_REQUEST", message: "O acordo não pode aumentar a parcela original." });
    return { contractId: installment.contractId, originalAmount, proposedAmount: input.proposedAmount, discountAmount: Number((originalAmount - input.proposedAmount).toFixed(2)), proposedDueDate: input.proposedDueDate };
  }),

  createRenegotiation: financeProcedure.input(z.object({ installmentId: z.number().int().positive(), proposedAmount: z.coerce.number().positive(), proposedDueDate: z.string().date(), notes: z.string().trim().max(2000).nullable().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const renegotiation = await db.transaction(async tx => {
      const installment = (await tx.select().from(installments).where(eq(installments.id, input.installmentId)).limit(1).for("update"))[0];
      if (!installment) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
      const originalAmount = Number(installment.amount);
      if (["paid", "cancelled", "renegotiated"].includes(installment.status) || input.proposedAmount > originalAmount) throw new TRPCError({ code: "BAD_REQUEST", message: "Acordo inválido para esta parcela." });
      const active = (await tx.select({ id: installmentRenegotiations.id }).from(installmentRenegotiations).where(and(eq(installmentRenegotiations.originalInstallmentId, input.installmentId), inArray(installmentRenegotiations.status, ["draft", "approved", "applied"]))).limit(1))[0];
      if (active) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma renegociação ativa para esta parcela." });
      const created = await tx.insert(installmentRenegotiations).values({ contractId: installment.contractId, originalInstallmentId: installment.id, originalAmount: originalAmount.toFixed(2), proposedAmount: input.proposedAmount.toFixed(2), proposedDueDate: dateValue(input.proposedDueDate), discountAmount: (originalAmount - input.proposedAmount).toFixed(2), notes: input.notes || null, createdByUserId: ctx.user.id }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o acordo." });
      return { id, sequence: installment.sequence, installmentId: installment.id, proposedAmount: input.proposedAmount };
    });
    await recordAudit(ctx.user.id, "installment_renegotiation", renegotiation.id, "created", `Acordo proposto para parcela ${renegotiation.sequence}.`);
    await recordDomainEvent({ eventName: "installment.renegotiation.proposed", aggregateType: "installment_renegotiation", aggregateId: renegotiation.id, actorUserId: ctx.user.id, payload: { installmentId: renegotiation.installmentId, proposalAmount: renegotiation.proposedAmount } });
    return { id: renegotiation.id };
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
        if (["paid", "cancelled"].includes(row.installment.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "Não é possível emitir cobrança para uma parcela paga ou cancelada." });
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

        const externalReference = billingExternalReference(input.installmentId);
        const expectedBillingType = asaasBillingType(input.type);
        const existingRemote = (await runAsaas(() => findAsaasPaymentsByReference(config, externalReference))).data?.find(item => item.externalReference === externalReference && item.billingType === expectedBillingType);
        const payment = existingRemote || await runAsaas(() => createAsaasPayment(config, { customer: gatewayCustomerId, billingType: expectedBillingType, value: Number(row.installment.amount), dueDate: new Date(row.installment.dueDate).toISOString().slice(0, 10), description: `TGR-CRM · ${row.contract.number} · parcela ${row.installment.sequence}`, externalReference }));
        const identification = input.type === "boleto" ? await runAsaas(() => getAsaasIdentificationField(config, payment.id)) : null;
        const pix = input.type === "pix" ? await runAsaas(() => getAsaasPixQrCode(config, payment.id)) : null;
        const created = await tx.insert(billingRecords).values({ installmentId: input.installmentId, type: input.type, status: "generated", gatewayProvider: "asaas", gatewayPaymentId: payment.id, gatewayStatus: payment.status || "PENDING", amount: row.installment.amount, dueDate: row.installment.dueDate, externalReference, digitableLine: identification?.identificationField || null, pixCopyPaste: pix?.payload || null, pixQrCodeBase64: pix?.encodedImage || null, invoiceUrl: payment.invoiceUrl || null, bankSlipUrl: payment.bankSlipUrl || null, generatedAt: new Date() }).$returningId();
        const id = created[0]?.id;
        if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Cobrança criada no gateway, mas não foi persistida no CRM." });
          return { id, gatewayPaymentId: payment.id, reused: false };
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "A cobrança foi processada, mas não foi possível confirmar o estado no CRM." });
      }
      if (issued.reused) return issued;
      await recordAudit(ctx.user.id, "billing_record", issued.id, "gateway_issued", `Cobrança ${input.type.toUpperCase()} emitida pelo Asaas para parcela ${input.installmentId}.`);
      await recordDomainEvent({ eventName: "financial.billing.created", aggregateType: "billing_record", aggregateId: issued.id, actorUserId: ctx.user.id, payload: { installmentId: input.installmentId, gatewayProvider: "asaas", gatewayPaymentId: issued.gatewayPaymentId, type: input.type } });
      return issued;
    }),

  registerBilling: financeProcedure.input(z.object({ installmentId: z.number().int().positive(), type: z.enum(["boleto", "pix", "card", "transfer"]), amount: z.coerce.number().positive(), dueDate: z.string().date(), externalReference: z.string().trim().max(255).optional().nullable(), digitableLine: z.string().trim().max(255).optional().nullable(), pixCopyPaste: z.string().trim().max(4000).optional().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (["boleto", "pix"].includes(input.type)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PIX e boleto precisam ser emitidos pelo gateway configurado; o registro manual foi bloqueado para evitar cobrança fictícia." });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const created = await db.transaction(async tx => {
        const installment = (await tx.select({ id: installments.id, status: installments.status }).from(installments).where(eq(installments.id, input.installmentId)).limit(1).for("update"))[0];
        if (!installment) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela da cobrança não encontrada." });
        if (["paid", "cancelled"].includes(installment.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "Não é possível registrar cobrança para uma parcela paga ou cancelada." });
        const externalReference = input.externalReference?.trim() || `TGR-${input.installmentId}-${Date.now()}`;
        const duplicateReference = (await tx.select({ id: billingRecords.id }).from(billingRecords).where(and(eq(billingRecords.gatewayProvider, "manual"), eq(billingRecords.externalReference, externalReference))).limit(1))[0];
        if (duplicateReference) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma cobrança manual com esta referência externa." });
        const activeDuplicate = (await tx.select({ id: billingRecords.id }).from(billingRecords).where(and(eq(billingRecords.installmentId, input.installmentId), eq(billingRecords.type, input.type), eq(billingRecords.gatewayProvider, "manual"), inArray(billingRecords.status, ["pending", "generated", "paid"]))).limit(1))[0];
        if (activeDuplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma cobrança manual ativa para esta parcela e tipo." });
        const inserted = await tx.insert(billingRecords).values({ ...input, gatewayProvider: "manual", amount: input.amount.toFixed(2), dueDate: dateValue(input.dueDate), externalReference, digitableLine: null, pixCopyPaste: null, status: "generated", generatedAt: new Date() }).$returningId();
        const id = inserted[0]?.id;
        if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar a cobrança." });
        return { id };
      });
      await recordAudit(ctx.user.id, "billing_record", created.id, "registered", `Cobrança ${input.type} registrada.`);
      await recordDomainEvent({ eventName: "financial.billing.created", aggregateType: "billing_record", aggregateId: created.id, actorUserId: ctx.user.id, payload: { installmentId: input.installmentId, gatewayProvider: "manual", type: input.type } });
      return created;
    }),

  markInstallmentPaid: financeProcedure.input(z.object({ id: z.number().int().positive(), paymentMethod: z.string().trim().max(64).optional().nullable() }))
    .mutation(async ({ ctx, input }) => {
      assertCapability(ctx.user.role, "finance.installment.settle", "Somente financeiro pode baixar parcelas.");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const item = (await db.select().from(installments).where(eq(installments.id, input.id)).limit(1))[0];
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Parcela não encontrada." });
      if (item.status === "paid") return { success: true, alreadyPaid: true, commissionBlocked: false };
      const contract = (await db.select().from(contracts).where(eq(contracts.id, item.contractId)).limit(1))[0] ?? null;
      const proposal = contract?.proposalId ? ((await db.select().from(proposals).where(eq(proposals.id, contract.proposalId)).limit(1))[0] ?? null) : null;
      const opportunity = proposal?.opportunityId ? ((await db.select().from(opportunities).where(eq(opportunities.id, proposal.opportunityId)).limit(1))[0] ?? null) : null;
      const capture = opportunity?.id ? ((await db.select().from(captureRecords).where(eq(captureRecords.opportunityId, opportunity.id)).orderBy(desc(captureRecords.createdAt)).limit(1))[0] ?? null) : null;
      const commissionContext = contract ? { contract, proposal, opportunity, capture } : null;
      const policyRow = commissionContext?.capture?.resortId ? (await db.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, commissionContext.capture.resortId)).limit(1))[0] : null; const commissionPolicy = parseCompleteCommissionPolicy(policyRow?.commissionPolicy); const commissionNeedsPolicy = Boolean(commissionContext?.proposal && commissionContext.capture && Number(commissionContext.proposal.downPaymentAmount) > 0); const commissionBlocked = commissionNeedsPolicy && !commissionPolicy;
      const createdCommissionFacts: Array<{ id: number; sellerId: number; campaignId: number | null; opportunityId: number | null; contractId: number; sourceInstallmentId: number; commissionRole: string; amount: number; rate: number }> = [];
      const settled = await db.transaction(async tx => {
        const updateResult = await tx.update(installments).set({ status: "paid", paidAt: new Date(), paymentMethod: input.paymentMethod || null }).where(and(eq(installments.id, input.id), ne(installments.status, "paid")));
        if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) return false;
        await tx.update(billingRecords).set({ status: "paid" }).where(and(eq(billingRecords.installmentId, input.id), inArray(billingRecords.status, ["pending", "generated"])));
        await tx.insert(financialTransactions).values({ contractId: item.contractId, campaignId: null, type: "income", category: "Parcela de contrato", description: `Baixa da parcela ${item.sequence}`, amount: item.amount, dueDate: item.dueDate, paidAt: new Date(), status: "paid", createdByUserId: ctx.user.id });
        if (commissionContext?.proposal && commissionContext.capture && Number(commissionContext.proposal.downPaymentAmount) > 0 && commissionPolicy) { const exists = await tx.select({ id: salesCommissions.id }).from(salesCommissions).where(eq(salesCommissions.sourceInstallmentId, item.id)).limit(1); if (!exists.length) { const method = (["pix", "debit", "credit", "boleto", "cash", "cheque"].includes((input.paymentMethod || "").toLowerCase()) ? (input.paymentMethod || "").toLowerCase() : "other") as Parameters<typeof buildInstallmentCommissions>[0]["paymentMethod"]; const rows = buildInstallmentCommissions({ installmentId: item.id, installmentAmount: Number(item.amount), entryTotal: Number(commissionContext.proposal.downPaymentAmount), contractTotal: Number(commissionContext.contract.totalAmount), paymentMethod: method, compensatedAt: new Date(), linerId: commissionContext.capture.linerId, closerId: commissionContext.capture.closerId, rates: { liner: commissionPolicy.linerRate, closer: commissionPolicy.closerRate, ftb: commissionPolicy.ftbRate }, calendar: { cancellationDeadlineDay: commissionPolicy.cancellationDeadlineDay, expectedPaymentDay: commissionPolicy.expectedPaymentDay } }); if (rows.length) { const commissionValues = rows.map(row => ({ ...row, contractId: item.contractId, opportunityId: commissionContext.opportunity?.id ?? null, campaignId: commissionContext.capture?.campaignId ?? null, baseAmount: row.baseAmount.toFixed(2), rate: row.rate.toFixed(2), amount: row.amount.toFixed(2), lifecycleStatus: row.lifecycleStatus, paymentMethod: row.paymentMethod })); const insertedCommissions = await tx.insert(salesCommissions).values(commissionValues).$returningId(); insertedCommissions.forEach((inserted, index) => { const row = commissionValues[index]; if (row && inserted?.id) createdCommissionFacts.push({ id: inserted.id, sellerId: row.sellerId, campaignId: row.campaignId, opportunityId: row.opportunityId, contractId: row.contractId, sourceInstallmentId: row.sourceInstallmentId, commissionRole: row.commissionRole, amount: Number(row.amount), rate: Number(row.rate) }); }); } } }
        return true;
      });
      if (!settled) return { success: true, alreadyPaid: true, commissionBlocked: false };
      await recordAudit(ctx.user.id, "installment", input.id, "paid", `Parcela ${item.sequence} baixada como paga.`);
      if (commissionBlocked) {
        await recordAudit(ctx.user.id, "installment", input.id, "commission_blocked", "Comissão automática bloqueada: a política completa do empreendimento não está configurada.");
        await recordDomainEvent({ eventName: "commission.automatic.blocked", aggregateType: "installment", aggregateId: input.id, actorUserId: ctx.user.id, payload: { contractId: item.contractId, reason: "incomplete_project_policy" } });
      }
      await recordDomainEvent({ eventName: "installment.paid", aggregateType: "installment", aggregateId: input.id, actorUserId: ctx.user.id, payload: { installmentId: input.id, paidAmount: item.amount, contractId: item.contractId, sequence: item.sequence, amount: item.amount, source: "manual", gatewayPaymentId: null, commissionBlocked } });
      for (const commission of createdCommissionFacts) { await recordAudit(ctx.user.id, "sales_commission", commission.id, "created", `Comissão automática ${commission.commissionRole} de ${commission.amount.toFixed(2)} criada.`); await recordDomainEvent({ eventName: "commission.created", aggregateType: "sales_commission", aggregateId: commission.id, actorUserId: ctx.user.id, payload: { sellerId: commission.sellerId, campaignId: commission.campaignId, opportunityId: commission.opportunityId, contractId: commission.contractId, sourceInstallmentId: commission.sourceInstallmentId, commissionRole: commission.commissionRole, amount: commission.amount, rate: commission.rate } }); }
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
    const db = await getDb(); if (!db) return [];
    return db.select({ id: salesCampaigns.id, name: salesCampaigns.name, code: salesCampaigns.code, status: salesCampaigns.status }).from(salesCampaigns).orderBy(salesCampaigns.name).limit(200);
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
        created = await db.insert(financialTransactions).values({ idempotencyKey: input.idempotencyKey ?? null, contractId: expectedContractId, campaignId: expectedCampaignId, type: input.type, category: input.category, description: input.description, amount: expectedAmount, dueDate: expectedDueDate, status: input.status, paidAt: input.status === "paid" ? new Date() : null, createdByUserId: ctx.user.id }).$returningId();
      } catch (error) {
        if (!input.idempotencyKey || !isDuplicateKeyError(error)) throw error;
        const existing = (await db.select({ id: financialTransactions.id, contractId: financialTransactions.contractId, campaignId: financialTransactions.campaignId, type: financialTransactions.type, category: financialTransactions.category, description: financialTransactions.description, amount: financialTransactions.amount, dueDate: financialTransactions.dueDate, status: financialTransactions.status }).from(financialTransactions).where(eq(financialTransactions.idempotencyKey, input.idempotencyKey)).limit(1))[0];
        if (!existing) throw new TRPCError({ code: "CONFLICT", message: "O lançamento foi criado por outra operação. Recarregue a tela." });
        if (!matchesExisting(existing)) throw new TRPCError({ code: "CONFLICT", message: "A chave idempotente já foi usada para outro lançamento." });
        return { id: existing.id, reused: true };
      }
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o lançamento." });
      await recordAudit(ctx.user.id, "financial_transaction", id, "created", `Lançamento ${input.type} criado.`);
      await recordDomainEvent({ eventName: "financial.entry.created", aggregateType: "financial_transaction", aggregateId: id, actorUserId: ctx.user.id, payload: { type: input.type, category: input.category, amount: input.amount, contractId: expectedContractId, campaignId: expectedCampaignId } });
      return { id, reused: false };
    }),

  reconcileEntry: financeProcedure.input(z.object({ id: z.number().int().positive(), reconciliationReference: z.string().trim().min(3).max(255) })).mutation(async ({ ctx, input }) => {
    assertCapability(ctx.user.role, "finance.payment.reconcile");
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const entry = (await db.select().from(financialTransactions).where(eq(financialTransactions.id, input.id)).limit(1))[0];
    if (!entry) throw new TRPCError({ code: "NOT_FOUND", message: "Lançamento não encontrado." });
    if (entry.status !== "paid") throw new TRPCError({ code: "BAD_REQUEST", message: "Apenas lançamentos pagos podem ser conciliados." });
    if (entry.reconciledAt) return { success: true, alreadyReconciled: true };
    const reconciledAt = new Date();
    const updateResult = await db.update(financialTransactions).set({ reconciliationReference: input.reconciliationReference, reconciledAt, reconciledByUserId: ctx.user.id }).where(and(eq(financialTransactions.id, input.id), isNull(financialTransactions.reconciledAt)));
    if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) return { success: true, alreadyReconciled: true };
    await recordAudit(ctx.user.id, "financial_transaction", input.id, "reconciled", `Lançamento conciliado pela referência ${input.reconciliationReference}.`);
    await recordDomainEvent({ eventName: "financial.entry.reconciled", aggregateType: "financial_transaction", aggregateId: input.id, actorUserId: ctx.user.id, payload: { reference: input.reconciliationReference, reconciledAt } });
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
        created = await db.insert(financialTransfers).values({ idempotencyKey: input.idempotencyKey ?? null, contractId: input.contractId ?? null, beneficiaryName: input.beneficiaryName, description: input.description || null, amount: expectedAmount, dueDate: expectedDueDate }).$returningId();
      } catch (error) {
        if (!input.idempotencyKey || !(error && typeof error === "object" && "code" in error && String(error.code) === "ER_DUP_ENTRY")) throw error;
        const existing = (await db.select({ id: financialTransfers.id, contractId: financialTransfers.contractId, beneficiaryName: financialTransfers.beneficiaryName, description: financialTransfers.description, amount: financialTransfers.amount, dueDate: financialTransfers.dueDate }).from(financialTransfers).where(eq(financialTransfers.idempotencyKey, input.idempotencyKey)).limit(1))[0];
        if (!existing) throw new TRPCError({ code: "CONFLICT", message: "O repasse foi criado por outra operação. Recarregue a tela." });
        if (!matchesExisting(existing)) throw new TRPCError({ code: "CONFLICT", message: "A chave idempotente já foi usada para outro repasse." });
        return { id: existing.id, reused: true };
      }
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar o repasse." });
      await recordAudit(ctx.user.id, "financial_transfer", id, "created", `Repasse para ${input.beneficiaryName} registrado.`);
      await recordDomainEvent({ eventName: "financial.transfer.created", aggregateType: "financial_transfer", aggregateId: id, actorUserId: ctx.user.id, payload: { recipient: input.beneficiaryName, amount: input.amount, contractId: input.contractId ?? null } });
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
      if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) return { success: true, alreadyPaid: true };
      return { success: true, alreadyPaid: false, amount: transfer.amount, contractId: transfer.contractId };
    });
    if (!outcome.alreadyPaid) {
      await recordAudit(ctx.user.id, "financial_transfer", input.id, "paid", "Repasse baixado como pago.");
      await recordDomainEvent({ eventName: "financial.transfer.paid", aggregateType: "financial_transfer", aggregateId: input.id, actorUserId: ctx.user.id, payload: { amount: outcome.amount, contractId: outcome.contractId } });
    }
    return { success: outcome.success, alreadyPaid: outcome.alreadyPaid };
  }),
});
