// Comissão automática de parcela paga: UM só construtor/portão para baixa manual, webhook do gateway e validação final da
// venda (ADR-007). Parcela paga ANTES da validação fica bloqueada; ao validar, as parcelas já pagas são reavaliadas aqui.
import { and, eq, ne, isNotNull, sql } from "drizzle-orm";
import { commercialFractions, salesCommissions } from "../drizzle/schema";
import { computeCommissionV2, type CommissionRulesV2 } from "../shared/commissionRulesV2";
import { buildInstallmentCommissions, buildInstallmentCommissionsV2, canCommissionBecomeDue, commissionRoleRate, type CommissionRoleV2Mapped } from "./commissionAutomation";
import { commissionAssignments, type PaymentMethod } from "./commissionLifecycle";
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

/** Motivo do `commission.automatic.skipped`: o portão passou mas nenhum papel da parcela tem percentual > 0 (janela de 0%). */
export const COMMISSION_SKIPPED_REASON = "zero_rate" as const;
export const COMMISSION_SKIPPED_MESSAGE = "Comissão automática não lançada: nenhum papel da venda tem percentual maior que 0% na política do empreendimento (0% = sem lançamento).";

/**
 * ADR-010: papéis atribuídos à venda quando NENHUM deles tem taxa > 0 (a parcela paga fica sem comissão e precisa ficar
 * rastreável para reprocesso após ajuste das taxas). `null` quando algum papel é pagável ou não há papel atribuído.
 */
/**
 * CRM-A13: a política V2 só vale LIBERADA (COMMISSION_V2_RELEASED=true) e com `rulesV2` na política do empreendimento. Travada (padrão), isto é
 * sempre falso e a geração por parcela segue exatamente o V1 (ADR-010: 0% = nenhum lançamento). Liberar é decisão do Lucas.
 */
/** Lido a cada chamada (não no carregamento do módulo): liberar ou travar não exige reinício do código nem import novo. */
export const isCommissionV2Released = () => process.env.COMMISSION_V2_RELEASED === "true";
export const commissionV2Active = (policy: { rulesV2?: CommissionRulesV2 } | null | undefined): policy is { rulesV2: CommissionRulesV2 } => isCommissionV2Released() && Boolean(policy?.rulesV2);

/** Papéis V2 -> papéis gravados (padrão da política: captador=promoter, consultor=liner, fechador=closer) e de quem vem o pagamento na ficha. */
export const COMMISSION_V2_ROLE_MAP = { captador: "promoter", consultor: "liner", fechador: "closer" } as const satisfies Record<string, CommissionRoleV2Mapped>;
const V2_PAYEE: Record<CommissionRoleV2Mapped, "promoterId" | "linerId" | "closerId"> = { promoter: "promoterId", liner: "linerId", closer: "closerId" };

export function zeroRateSkippedRoles(capture: { linerId: number | null; closerId: number | null } | null | undefined, policy: Pick<CompleteCommissionPolicy, "linerRate" | "closerRate" | "ftbRate"> & { rulesV2?: CommissionRulesV2 }): string[] | null {
  if (!capture) return null;
  // V2 liberada: o motor V2 decide o valor por parcela (pode resultar 0 sem rastro de "skip"; o V1 não vale aqui).
  if (commissionV2Active(policy)) return null;
  const assignments = commissionAssignments({ linerId: capture.linerId, closerId: capture.closerId });
  if (!assignments.length) return null;
  const rates = { liner: policy.linerRate, closer: policy.closerRate, ftb: policy.ftbRate };
  return assignments.some(assignee => commissionRoleRate(rates, assignee.role) > 0) ? null : assignments.map(assignee => assignee.role);
}

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
  capture: { campaignId: number | null; linerId: number | null; closerId: number | null; promoterId?: number | null } | null;
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
  // Issue #38 (1): acumulado automático (de parcela, não cancelado; lançamentos manuais ficam de fora) por papel no contrato, para limitar a proração ao total devido.
  const alreadyReleased: Partial<Record<"liner" | "closer" | "ftb" | "promoter", number>> = {};
  const previous = await tx.select({ role: salesCommissions.commissionRole, amount: salesCommissions.amount }).from(salesCommissions).where(and(eq(salesCommissions.contractId, installment.contractId), ne(salesCommissions.status, "cancelled"), isNotNull(salesCommissions.sourceInstallmentId)));
  previous.forEach(row => { alreadyReleased[row.role] = Math.round(((alreadyReleased[row.role] ?? 0) + Number(row.amount)) * 100) / 100; });
  const calendar = { cancellationDeadlineDay: policy.cancellationDeadlineDay, expectedPaymentDay: policy.expectedPaymentDay };
  const entryTotal = Number(context.proposal.downPaymentAmount);
  const v2Rows = async () => {
    // Cotas da venda = frações vendidas ao contrato (mínimo 1: contrato sem fração ligada, ex. importado por CSV, conta uma cota).
    const [quotaRow] = await tx.select({ n: sql<number>`COUNT(*)` }).from(commercialFractions).where(eq(commercialFractions.currentContractId, installment.contractId));
    const result = computeCommissionV2(policy.rulesV2, { quotas: Math.max(1, Number(quotaRow?.n ?? 0)), entryCents: Math.round(entryTotal * 100), saleTotalCents: Math.round(Number(context.contract.totalAmount) * 100) });
    const capture = context.capture!;
    const lines = result.lines.flatMap(line => {
      const role = COMMISSION_V2_ROLE_MAP[line.role];
      const userId = capture[V2_PAYEE[role]];
      return userId ? [{ role, userId, totalReais: line.amountCents / 100 }] : [];
    });
    return buildInstallmentCommissionsV2({ installmentId: installment.id, installmentAmount: Number(installment.amount), entryTotal, paymentMethod: input.paymentMethod, compensatedAt: input.compensatedAt, lines, alreadyReleased, calendar });
  };
  const rows = (commissionV2Active(policy) ? await v2Rows() : buildInstallmentCommissions({
    installmentId: installment.id, installmentAmount: Number(installment.amount), entryTotal,
    contractTotal: Number(context.contract.totalAmount), paymentMethod: input.paymentMethod, compensatedAt: input.compensatedAt,
    linerId: context.capture.linerId, closerId: context.capture.closerId,
    rates: { liner: policy.linerRate, closer: policy.closerRate, ftb: policy.ftbRate }, alreadyReleased, calendar,
  })).filter(row => !existingRoles.has(row.commissionRole));
  if (!rows.length) return [];
  const values = rows.map(row => ({ ...row, contractId: installment.contractId, opportunityId: context.opportunity?.id ?? null, campaignId: context.capture?.campaignId ?? null, baseAmount: row.baseAmount.toFixed(2), rate: row.rate.toFixed(2), amount: row.amount.toFixed(2), lifecycleStatus: row.lifecycleStatus, paymentMethod: row.paymentMethod }));
  const inserted = await tx.insert(salesCommissions).values(values).$returningId();
  const facts: CreatedCommissionFact[] = [];
  inserted.forEach((row, index) => { const value = values[index]; if (value && row?.id) facts.push({ id: row.id, sellerId: value.sellerId, campaignId: value.campaignId, opportunityId: value.opportunityId, contractId: value.contractId, sourceInstallmentId: value.sourceInstallmentId, commissionRole: value.commissionRole, amount: Number(value.amount), rate: Number(value.rate) });  });
  return facts;
}
