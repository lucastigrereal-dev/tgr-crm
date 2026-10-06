// Comissão automática de parcela paga: UM só construtor/portão para baixa manual, webhook do gateway e validação final da
// venda (ADR-007). Parcela paga ANTES da validação fica bloqueada; ao validar, as parcelas já pagas são reavaliadas aqui.
import { eq } from "drizzle-orm";
import { salesCommissions } from "../drizzle/schema";
import { buildInstallmentCommissions, canCommissionBecomeDue } from "./commissionAutomation";
import type { PaymentMethod } from "./commissionLifecycle";
import type { getDb } from "./db";
import type { parseCompleteCommissionPolicy } from "./projectPolicy";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type CommissionWriter = Db | Tx;
export type CompleteCommissionPolicy = NonNullable<ReturnType<typeof parseCompleteCommissionPolicy>>;

/** Motivo do bloqueio (payload de `commission.automatic.blocked`). Venda não validada tem precedência sobre política. */
export type CommissionBlockReason = "sale_not_validated" | "incomplete_project_policy" | "contract_not_active";

export function commissionBlockReason(contractStatus: string | null | undefined, policy: unknown, saleValidated: boolean): CommissionBlockReason | null {
  if (canCommissionBecomeDue(contractStatus, policy, saleValidated)) return null;
  if (!saleValidated) return "sale_not_validated";
  if (!policy) return "incomplete_project_policy";
  return "contract_not_active";
}

export const COMMISSION_BLOCKED_MESSAGE: Record<CommissionBlockReason, string> = {
  sale_not_validated: "Comissão automática bloqueada: a venda ainda não foi validada pelo gerente.",
  incomplete_project_policy: "Comissão automática bloqueada: a política completa de comissão do empreendimento não está configurada.",
  contract_not_active: "Comissão automática bloqueada: o contrato não está ativo.",
};

export const KNOWN_PAYMENT_METHODS = ["pix", "debit", "credit", "boleto", "cash", "cheque"] as const;
export const normalizePaymentMethod = (raw: string | null | undefined): PaymentMethod => {
  const value = (raw ?? "").toLowerCase();
  return ((KNOWN_PAYMENT_METHODS as readonly string[]).includes(value) ? value : "other") as PaymentMethod;
};

export type CreatedCommissionFact = { id: number; sellerId: number; campaignId: number | null; opportunityId: number | null; contractId: number; sourceInstallmentId: number; commissionRole: string; amount: number; rate: number };

export type InstallmentCommissionContext = {
  contract: { id: number; status: string; totalAmount: string | number };
  proposal: { downPaymentAmount: string | number } | null;
  opportunity: { id: number } | null;
  capture: { campaignId: number | null; linerId: number | null; closerId: number | null } | null;
};

/** Só há comissão automática quando existem proposta + captação e entrada > 0 (regra de sempre). */
export const commissionApplies = (context: InstallmentCommissionContext | null | undefined) =>
  Boolean(context?.proposal && context.capture && Number(context.proposal.downPaymentAmount) > 0);

/**
 * Insere as comissões de UMA parcela (idempotente por sourceInstallmentId + commissionRole: nunca duplica) e devolve os
 * fatos criados. O CHAMADOR já decidiu pelo portão (`commissionBlockReason === null`) e tem a política completa.
 */
export async function insertInstallmentCommissions(tx: CommissionWriter, input: {
  installment: { id: number; amount: string | number; contractId: number };
  context: InstallmentCommissionContext;
  policy: CompleteCommissionPolicy;
  paymentMethod: PaymentMethod;
  compensatedAt: Date;
}): Promise<CreatedCommissionFact[]> {
  const { installment, context, policy } = input;
  if (!context.proposal || !context.capture) return [];
  const existing = await tx.select({ id: salesCommissions.id, role: salesCommissions.commissionRole }).from(salesCommissions).where(eq(salesCommissions.sourceInstallmentId, installment.id));
  const existingRoles = new Set(existing.map(row => row.role));
  const rows = buildInstallmentCommissions({
    installmentId: installment.id, installmentAmount: Number(installment.amount), entryTotal: Number(context.proposal.downPaymentAmount),
    contractTotal: Number(context.contract.totalAmount), paymentMethod: input.paymentMethod, compensatedAt: input.compensatedAt,
    linerId: context.capture.linerId, closerId: context.capture.closerId,
    rates: { liner: policy.linerRate, closer: policy.closerRate, ftb: policy.ftbRate },
    calendar: { cancellationDeadlineDay: policy.cancellationDeadlineDay, expectedPaymentDay: policy.expectedPaymentDay },
  }).filter(row => !existingRoles.has(row.commissionRole));
  if (!rows.length) return [];
  const values = rows.map(row => ({ ...row, contractId: installment.contractId, opportunityId: context.opportunity?.id ?? null, campaignId: context.capture?.campaignId ?? null, baseAmount: row.baseAmount.toFixed(2), rate: row.rate.toFixed(2), amount: row.amount.toFixed(2), lifecycleStatus: row.lifecycleStatus, paymentMethod: row.paymentMethod }));
  const inserted = await tx.insert(salesCommissions).values(values).$returningId();
  const facts: CreatedCommissionFact[] = [];
  inserted.forEach((row, index) => { const value = values[index]; if (value && row?.id) facts.push({ id: row.id, sellerId: value.sellerId, campaignId: value.campaignId, opportunityId: value.opportunityId, contractId: value.contractId, sourceInstallmentId: value.sourceInstallmentId, commissionRole: value.commissionRole, amount: Number(value.amount), rate: Number(value.rate) });  });
  return facts;
}
