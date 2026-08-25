import { and, eq, ne } from "drizzle-orm";
import { billingRecords, captureRecords, commercialProjectSettings, contracts, financialTransactions, installments, opportunities, paymentGatewayWebhookEvents, proposals, salesCommissions } from "../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "./db";
import { getAsaasConfig, isAsaasPaymentConfirmed, isAsaasPaymentOverdue, isAsaasWebhookTokenValid } from "./paymentGateway";
import { buildInstallmentCommissions } from "./commissionAutomation";
import { parseCompleteCommissionPolicy } from "./projectPolicy";
import { syncRevenueQualityForContract } from "./revenueQualitySync";

export type AsaasWebhookPayload = {
  id?: string;
  event?: string;
  payment?: {
    id?: string;
    status?: string;
    billingType?: string;
  };
};

export type ProcessAsaasWebhookResult = {
  status: 200 | 202 | 401 | 503;
  duplicate?: boolean;
  ignored?: boolean;
  billingRecordId?: number | null;
  installmentPaid?: boolean;
  message: string;
};

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown; sqlState?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || Number(candidate.code) === 1062 || Number(candidate.errno) === 1062 || candidate.sqlState === "23000";
}

export async function processAsaasWebhook(token: string | undefined, payload: AsaasWebhookPayload): Promise<ProcessAsaasWebhookResult> {
  const config = getAsaasConfig();
  if (!config) return { status: 503, message: "Gateway Asaas não configurado." };
  if (!isAsaasWebhookTokenValid(config, token)) return { status: 401, message: "Token de webhook inválido." };

  const event = typeof payload.event === "string" ? payload.event.trim() : "";
  const paymentId = typeof payload.payment?.id === "string" ? payload.payment.id.trim() : "";
  if (!event || !paymentId) return { status: 202, ignored: true, message: "Evento sem pagamento ignorado." };

  const db = await getDb();
  if (!db) return { status: 503, message: "Banco indisponível." };
  const eventId = typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : `${event}:${paymentId}`;
  const existingEvent = (await db.select({ id: paymentGatewayWebhookEvents.id }).from(paymentGatewayWebhookEvents).where(and(eq(paymentGatewayWebhookEvents.gatewayProvider, "asaas"), eq(paymentGatewayWebhookEvents.gatewayEventId, eventId))).limit(1))[0];
  if (existingEvent) return { status: 200, duplicate: true, message: "Evento já processado." };

  const billing = (await db.select({ billing: billingRecords, installment: installments }).from(billingRecords).innerJoin(installments, eq(billingRecords.installmentId, installments.id)).where(and(eq(billingRecords.gatewayProvider, "asaas"), eq(billingRecords.gatewayPaymentId, paymentId))).limit(1))[0];
  let installmentPaid = false;

  try {
    await db.transaction(async tx => {
      await tx.insert(paymentGatewayWebhookEvents).values({ gatewayProvider: "asaas", gatewayEventId: eventId, eventType: event, billingRecordId: billing?.billing.id ?? null });
      if (!billing) return;

      if (isAsaasPaymentConfirmed(event)) {
        await tx.update(billingRecords).set({ status: "paid", gatewayStatus: payload.payment?.status || event }).where(eq(billingRecords.id, billing.billing.id));
        const paidAt = new Date();
        const installmentUpdate = await tx.update(installments).set({ status: "paid", paidAt, paymentMethod: billing.billing.type }).where(and(eq(installments.id, billing.installment.id), ne(installments.status, "paid")));
        const installmentWasSettled = !(installmentUpdate && typeof installmentUpdate === "object" && "affectedRows" in installmentUpdate && Number(installmentUpdate.affectedRows) === 0);
        if (installmentWasSettled) {
          installmentPaid = true;
          await tx.insert(financialTransactions).values({ contractId: billing.installment.contractId, campaignId: null, type: "income", category: "Parcela de contrato", description: `Baixa via gateway Asaas · parcela ${billing.installment.sequence}`, amount: billing.installment.amount, dueDate: billing.installment.dueDate, paidAt, status: "paid", createdByUserId: null });
        }
      } else if (isAsaasPaymentOverdue(event)) {
        await tx.update(billingRecords).set({ status: "expired", gatewayStatus: payload.payment?.status || event }).where(eq(billingRecords.id, billing.billing.id));
      } else {
        await tx.update(billingRecords).set({ gatewayStatus: payload.payment?.status || event }).where(eq(billingRecords.id, billing.billing.id));
      }
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) return { status: 200, duplicate: true, message: "Evento já processado." };
    throw error;
  }

  await recordAudit(null, "billing_record", billing?.billing.id ?? paymentId, `gateway_${event.toLowerCase()}`, `Webhook Asaas recebido para pagamento ${paymentId}.`);
  if (billing && installmentPaid) {
    const context = (await db.select({ contract: contracts, proposal: proposals, opportunity: opportunities, capture: captureRecords }).from(contracts).leftJoin(proposals, eq(contracts.proposalId, proposals.id)).leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id)).leftJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id)).where(eq(contracts.id, billing.installment.contractId)).limit(1))[0];
    const policyRow = context?.capture?.resortId ? (await db.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, context.capture.resortId)).limit(1))[0] : null;
    const policy = parseCompleteCommissionPolicy(policyRow?.commissionPolicy);
    if (context?.contract && context.proposal && context.capture && Number(context.proposal.downPaymentAmount) > 0 && policy) {
      const existingCommission = (await db.select({ id: salesCommissions.id }).from(salesCommissions).where(eq(salesCommissions.sourceInstallmentId, billing.installment.id)).limit(1))[0];
      if (!existingCommission) {
        const paymentMethod = billing.billing.type === "pix" ? "pix" : "boleto";
        const rows = buildInstallmentCommissions({ installmentId: billing.installment.id, installmentAmount: Number(billing.installment.amount), entryTotal: Number(context.proposal.downPaymentAmount), contractTotal: Number(context.contract.totalAmount), paymentMethod, compensatedAt: new Date(), linerId: context.capture.linerId, closerId: context.capture.closerId, rates: { liner: policy.linerRate, closer: policy.closerRate, ftb: policy.ftbRate }, calendar: { cancellationDeadlineDay: policy.cancellationDeadlineDay, expectedPaymentDay: policy.expectedPaymentDay } });
        if (rows.length) await db.insert(salesCommissions).values(rows.map(row => ({ ...row, contractId: billing.installment.contractId, opportunityId: context.opportunity?.id ?? null, campaignId: context.capture?.campaignId ?? null, baseAmount: row.baseAmount.toFixed(2), rate: row.rate.toFixed(2), amount: row.amount.toFixed(2), lifecycleStatus: row.lifecycleStatus, paymentMethod: row.paymentMethod })));
      }
    }
    if (context?.contract && context.proposal && context.capture && Number(context.proposal.downPaymentAmount) > 0 && !policy) {
      await recordAudit(null, "installment", billing.installment.id, "commission_blocked", "Comissão automática bloqueada: a política completa do empreendimento não está configurada.");
      await recordDomainEvent({ eventName: "commission.automatic.blocked", aggregateType: "installment", aggregateId: billing.installment.id, actorUserId: null, payload: { contractId: billing.installment.contractId, reason: "incomplete_project_policy", source: "asaas" } });
    }
    await recordDomainEvent({ eventName: "installment.paid", aggregateType: "installment", aggregateId: billing.installment.id, actorUserId: null, payload: { contractId: billing.installment.contractId, sequence: billing.installment.sequence, amount: billing.installment.amount, source: "asaas", gatewayPaymentId: paymentId, commissionBlocked: Boolean(context?.contract && context.proposal && context.capture && Number(context.proposal.downPaymentAmount) > 0 && !policy) } });
    await syncRevenueQualityForContract({ contractId: billing.installment.contractId, actorUserId: null, trigger: "webhook Asaas" });
  }

  return { status: 200, billingRecordId: billing?.billing.id ?? null, installmentPaid, message: billing ? "Webhook processado." : "Evento registrado sem cobrança vinculada." };
}
