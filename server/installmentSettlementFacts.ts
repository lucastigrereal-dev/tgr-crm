// Issue #43: fatos da quitação de parcela que o Financial consome (`installment.paid`, `commission.created`) e o
// bloqueio automático de comissão nascem na MESMA transação da baixa (manual ou webhook). Antes iam depois do commit:
// queda do processo entre o commit e o insert deixava parcela paga sem evento na fila.
import { COMMISSION_BLOCKED_MESSAGE, type CommissionBlockReason, type CreatedCommissionFact } from "./installmentCommissions";
import { isInstallmentEvidenceInEventEnabled, type SettlementEvidence } from "./settlementEvidence";
import { txAudit, txEvent, type Tx } from "./txOutbox";

export type InstallmentSettlementFacts = {
  installmentId: number;
  contractId: number;
  sequence: number;
  amount: string;
  paidAmount: string;
  customerId?: number | null;
  source: "manual" | "asaas";
  /** CRM-H1: evidência do recebimento; só sai no evento com INSTALLMENT_EVIDENCE_IN_EVENT. */
  settlementEvidence?: SettlementEvidence;
  gatewayPaymentId: string | null;
  actorUserId: number | null;
  blockedReason: CommissionBlockReason | null;
  createdCommissions: CreatedCommissionFact[];
};

/** Parcela `paid` é estado terminal: uma quitação por parcela, então a chave por parcela torna o evento único. */
export const installmentPaidKey = (installmentId: number) => `installment-paid:${installmentId}`;

export async function recordInstallmentSettlementFacts(tx: Tx, facts: InstallmentSettlementFacts) {
  const { installmentId, contractId, source, actorUserId, blockedReason } = facts;
  if (source === "manual") await txAudit(tx, { actorUserId, entityType: "installment", entityId: installmentId, action: "paid", summary: `Parcela ${facts.sequence} baixada como paga.`, idempotencyKey: installmentPaidKey(installmentId) });
  if (blockedReason) {
    const key = `commission-blocked:${installmentId}:${blockedReason}:${source}`;
    await txAudit(tx, { actorUserId, entityType: "installment", entityId: installmentId, action: "commission_blocked", summary: COMMISSION_BLOCKED_MESSAGE[blockedReason], idempotencyKey: key });
    await txEvent(tx, { eventName: "commission.automatic.blocked", aggregateType: "installment", aggregateId: installmentId, actorUserId, payload: { contractId, reason: blockedReason, source }, idempotencyKey: key });
  }
  await txEvent(tx, { eventName: "installment.paid", aggregateType: "installment", aggregateId: installmentId, actorUserId, payload: { installmentId, paidAmount: facts.paidAmount, contractId, ...(facts.customerId ? { customerId: facts.customerId } : {}), sequence: facts.sequence, amount: facts.amount, source, gatewayPaymentId: facts.gatewayPaymentId, commissionBlocked: blockedReason !== null, ...(isInstallmentEvidenceInEventEnabled() ? { settlementEvidence: facts.settlementEvidence ?? (source === "asaas" ? "gateway_confirmed" : "receipt_claimed") } : {}) }, idempotencyKey: installmentPaidKey(installmentId) });
  for (const commission of facts.createdCommissions) {
    const key = `commission-created:${commission.id}`;
    await txAudit(tx, { actorUserId, entityType: "sales_commission", entityId: commission.id, action: "created", summary: `Comissão automática ${commission.commissionRole} de ${commission.amount.toFixed(2)} criada.`, idempotencyKey: key });
    await txEvent(tx, { eventName: "commission.created", aggregateType: "sales_commission", aggregateId: commission.id, actorUserId, payload: { sellerId: commission.sellerId, campaignId: commission.campaignId, opportunityId: commission.opportunityId, contractId: commission.contractId, sourceInstallmentId: commission.sourceInstallmentId, commissionRole: commission.commissionRole, amount: commission.amount, rate: commission.rate, ...(commission.policyVersion ? { policyVersion: commission.policyVersion } : {}) }, idempotencyKey: key });
  }
}
