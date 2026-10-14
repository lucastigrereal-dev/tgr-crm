import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { billingRecords, captureRecords, commercialProjectSettings, contracts, financialTransactions, installments, opportunities, paymentGatewayWebhookEvents, proposals, salesCommissions } from "../drizzle/schema";
import { getDb } from "./db";
import { getAsaasConfig, isAsaasPaymentConfirmed, isAsaasPaymentOverdue, isAsaasWebhookTokenValid } from "./paymentGateway";
import { isSaleValidated, recordZeroRateSkip } from "./saleValidationService";
import { commissionApplies, commissionBlockReason, insertInstallmentCommissions, zeroRateSkippedRoles, type CommissionBlockReason, type CreatedCommissionFact } from "./installmentCommissions";
import { parseCompleteCommissionPolicy } from "./projectPolicy";
import { syncRevenueQualityForContract } from "./revenueQualitySync";
import { affectedRows, isDuplicateKeyError } from "./mysqlErrors";
import { recordInstallmentSettlementFacts } from "./installmentSettlementFacts";
import { txAudit } from "./txOutbox";

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

  let billing = (await db.select({ billing: billingRecords, installment: installments }).from(billingRecords).innerJoin(installments, eq(billingRecords.installmentId, installments.id)).where(and(eq(billingRecords.gatewayProvider, "asaas"), eq(billingRecords.gatewayPaymentId, paymentId))).limit(1))[0];
  let installmentPaid = false;

  try {
    await db.transaction(async tx => {
      await tx.insert(paymentGatewayWebhookEvents).values({ gatewayProvider: "asaas", gatewayEventId: eventId, eventType: event, billingRecordId: billing?.billing.id ?? null });
      await txAudit(tx, { actorUserId: null, entityType: "billing_record", entityId: billing?.billing.id ?? paymentId, action: `gateway_${event.toLowerCase()}`, summary: `Webhook Asaas recebido para pagamento ${paymentId}.` });
      if (!billing) return;
      // Trava o contrato ANTES de cobrança/parcela (mesma ordem do distrato e da validação final): o gate de comissão lê a validação já serializada.
      await tx.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, billing.installment.contractId)).limit(1).for("update");
      const lockedBilling = (await tx.select({ billing: billingRecords, installment: installments }).from(billingRecords).innerJoin(installments, eq(billingRecords.installmentId, installments.id)).where(eq(billingRecords.id, billing.billing.id)).limit(1).for("update"))[0];
      if (!lockedBilling) return;
      billing = lockedBilling;

      if (isAsaasPaymentConfirmed(event)) {
        if (["cancelled", "expired", "paid"].includes(billing.billing.status) || ["cancelled", "renegotiated"].includes(billing.installment.status)) return;
        await tx.update(billingRecords).set({ status: "paid", gatewayStatus: payload.payment?.status || event }).where(and(eq(billingRecords.id, billing.billing.id), inArray(billingRecords.status, ["pending", "generated", "paid"])));
        const paidAt = new Date();
        const fullAmount = Number(billing.installment.amount);
        const previousPaid = Number(billing.installment.paidAmount ?? (billing.installment.status === "paid" ? billing.installment.amount : 0));
        const receivedNow = Number(billing.billing.amount ?? Math.max(0, fullAmount - previousPaid));
        const nextPaid = Math.min(fullAmount, Number((previousPaid + receivedNow).toFixed(2)));
        const fullyPaid = nextPaid >= fullAmount;
        const installmentUpdate = await tx.update(installments).set({
          status: fullyPaid ? "paid" : billing.installment.status,
          paidAmount: nextPaid.toFixed(2),
          paidAt: fullyPaid ? paidAt : billing.installment.paidAt,
          paymentMethod: billing.billing.type,
        }).where(and(eq(installments.id, billing.installment.id), inArray(installments.status, ["open", "overdue"])));
        const paymentRecorded = affectedRows(installmentUpdate) !== 0;
        if (paymentRecorded) {
          installmentPaid = fullyPaid;
          await tx.insert(financialTransactions).values({ contractId: billing.installment.contractId, campaignId: null, type: "income", category: "Parcela de contrato", description: `Recebimento via gateway Asaas · parcela ${billing.installment.sequence}`, amount: receivedNow.toFixed(2), dueDate: billing.installment.dueDate, paidAt, status: "paid", createdByUserId: null });
          if (fullyPaid) {
            const context = (await tx.select({ contract: contracts, proposal: proposals, opportunity: opportunities, capture: captureRecords }).from(contracts).leftJoin(proposals, eq(contracts.proposalId, proposals.id)).leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id)).leftJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id)).where(eq(contracts.id, billing.installment.contractId)).orderBy(desc(captureRecords.createdAt)).limit(1))[0];
            const settledCustomerId = context?.contract?.customerId ?? null;
            let blockedReason: CommissionBlockReason | null = null;
            const createdCommissionFacts: CreatedCommissionFact[] = [];
            const policyRow = context?.capture?.resortId ? (await tx.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, context.capture.resortId)).limit(1))[0] : null;
            const policy = parseCompleteCommissionPolicy(policyRow?.commissionPolicy);
            const saleValidated = await isSaleValidated(tx, context?.contract?.id);
            const commissionContext = context?.contract && context.proposal && context.capture ? { contract: context.contract, proposal: context.proposal, opportunity: context.opportunity, capture: context.capture } : null;
            if (commissionContext && commissionApplies(commissionContext)) {
              blockedReason = commissionBlockReason(commissionContext.contract.status, policy, saleValidated);
              // ADR-010: portão passou, mas nenhum papel tem taxa > 0 (janela de 0%): rastreável (auditoria + evento) para reprocesso.
              if (!blockedReason && policy) {
                // Issue #38 (2): o registro do skip nasce na MESMA transação do pagamento (idempotente por parcela).
                const zeroRoles = zeroRateSkippedRoles(commissionContext.capture, policy);
                if (zeroRoles) await recordZeroRateSkip(tx, { installmentId: billing.installment.id, contractId: billing.installment.contractId, resortId: commissionContext.capture.resortId ?? null, roles: zeroRoles, actorUserId: null, source: "asaas" });
              }
              if (!blockedReason && policy) createdCommissionFacts.push(...await insertInstallmentCommissions(tx, { installment: { id: billing.installment.id, amount: billing.installment.amount, contractId: billing.installment.contractId }, context: commissionContext, policy, paymentMethod: billing.billing.type === "pix" ? "pix" : "boleto", compensatedAt: paidAt }));
            }
            // Issue #43: fatos consumidos pelo Financial nascem na MESMA transação do pagamento (outbox em domain_events).
            await recordInstallmentSettlementFacts(tx, { installmentId: billing.installment.id, contractId: billing.installment.contractId, sequence: billing.installment.sequence, amount: billing.installment.amount, paidAmount: receivedNow.toFixed(2), customerId: settledCustomerId, source: "asaas", gatewayPaymentId: paymentId, actorUserId: null, blockedReason, createdCommissions: createdCommissionFacts });
          }
        }
      } else if (isAsaasPaymentOverdue(event) && ["pending", "generated"].includes(billing.billing.status)) {
        await tx.update(billingRecords).set({ status: "expired", gatewayStatus: payload.payment?.status || event }).where(and(eq(billingRecords.id, billing.billing.id), inArray(billingRecords.status, ["pending", "generated"])));
      } else {
        await tx.update(billingRecords).set({ gatewayStatus: payload.payment?.status || event }).where(eq(billingRecords.id, billing.billing.id));
      }
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) return { status: 200, duplicate: true, message: "Evento já processado." };
    throw error;
  }

  if (billing && installmentPaid) {
    await syncRevenueQualityForContract({ contractId: billing.installment.contractId, actorUserId: null, trigger: "webhook Asaas" });
  }

  return { status: 200, billingRecordId: billing?.billing.id ?? null, installmentPaid, message: billing ? "Webhook processado." : "Evento registrado sem cobrança vinculada." };
}
