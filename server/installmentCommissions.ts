// Comissão automática de parcela paga: UM só construtor/portão para baixa manual, webhook do gateway e validação final da
// venda (ADR-007). Parcela paga ANTES da validação fica bloqueada; ao validar, as parcelas já pagas são reavaliadas aqui.
import { and, asc, desc, eq, ne, isNotNull, sql } from "drizzle-orm";
import { commissionPolicyVersionOf } from "./commissionPolicyVersion";
import { txAudit, txEvent } from "./txOutbox";
import { commercialFractions, commissionRoleMapVersions, contractCommissionRoleMaps, installmentRenegotiations, installments, salesCommissions } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { parseCommissionRoleMap, type CommissionRoleMap } from "./commissionRoleMap";
import { computeCommissionV2, type CommissionRulesV2 } from "../shared/commissionRulesV2";
import { DEFAULT_PAYOUT_MODE, DEFAULT_RELEASE_ON } from "../shared/projectPolicySchemas";
import { buildInstallmentCommissions, buildInstallmentCommissionsV2, canCommissionBecomeDue, commissionRoleRate, entryInstallmentIds, isEntryFullyPaid, type CommissionRoleV2Mapped } from "./commissionAutomation";
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
export const COMMISSION_V2_LOCKED_REASON = "v2_locked" as const;
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
export const COMMISSION_V2_ROLE_MAP: CommissionRoleMap = { captador: "promoter", consultor: "liner", fechador: "closer" };

/**
 * Mapa de papéis deste contrato. Flag OFF: a constante, sem ler banco. Flag ON: snapshot do contrato; sem snapshot, fixa o mapa vigente (ou a constante se nunca houve
 * versão) com INSERT ... ON DUPLICATE no-op (corrida entre duas parcelas é inofensiva). Snapshot ilegível cai na constante (nunca paga com mapa inválido).
 */
export async function commissionRoleMapForContract(tx: CommissionWriter, contractId: number): Promise<CommissionRoleMap> {
  if (!ENV.commissionRoleMapEnabled) return COMMISSION_V2_ROLE_MAP;
  const [snapshot] = await tx.select().from(contractCommissionRoleMaps).where(eq(contractCommissionRoleMaps.contractId, contractId)).limit(1);
  if (snapshot) return parseCommissionRoleMap(safeJson(snapshot.roleMap)) ?? COMMISSION_V2_ROLE_MAP;
  const [current] = await tx.select().from(commissionRoleMapVersions).orderBy(desc(commissionRoleMapVersions.version)).limit(1);
  const map = (current && parseCommissionRoleMap(safeJson(current.roleMap))) || COMMISSION_V2_ROLE_MAP;
  await tx.insert(contractCommissionRoleMaps).values({ contractId, mapVersion: current?.version ?? 0, roleMap: JSON.stringify(map) }).onDuplicateKeyUpdate({ set: { contractId: sql`contractId` } });
  const [fixed] = await tx.select().from(contractCommissionRoleMaps).where(eq(contractCommissionRoleMaps.contractId, contractId)).limit(1);
  return (fixed && parseCommissionRoleMap(safeJson(fixed.roleMap))) || map;
}
function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
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

/** Pagamento posterior ao da parcela de referência: (paidAt, id) maior. Sem paidAt (legado) conta como já pago. */
const paidAfter = (row: { id: number; paidAt: Date | null }, referenceId: number, at: Date) => row.id !== referenceId && row.paidAt != null && (row.paidAt.getTime() > at.getTime() || (row.paidAt.getTime() === at.getTime() && row.id > referenceId));

export type CreatedCommissionFact = { id: number; sellerId: number; campaignId: number | null; opportunityId: number | null; contractId: number; sourceInstallmentId: number; commissionRole: string; amount: number; rate: number };

export type InstallmentCommissionContext = {
  contract: { id: number; status: string; totalAmount: string | number };
  proposal: { downPaymentAmount: string | number } | null;
  opportunity: { id: number } | null;
  capture: { resortId?: number | null; campaignId: number | null; linerId: number | null; closerId: number | null; promoterId?: number | null } | null;
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
  /** Reprocesso (validação da venda): avalia o acumulado da entrada COMO ERA no pagamento desta parcela (pagamentos posteriores ainda não existiam), para a comissão cheia nascer na parcela que completou a entrada, com a política e a data dela. */
  paidAsOf?: Date | null;
}): Promise<CreatedCommissionFact[]> {
  const { installment, context, policy } = input;
  if (!context.proposal || !context.capture) return [];
  const existing = await tx.select({ id: salesCommissions.id, role: salesCommissions.commissionRole }).from(salesCommissions).where(eq(salesCommissions.sourceInstallmentId, installment.id));
  const existingRoles = new Set(existing.map(row => row.role));
  // Issue #38 (1): acumulado automático (de parcela, não cancelado; lançamentos manuais ficam de fora) por papel no contrato, para limitar a proração ao total devido.
  const alreadyReleased: Partial<Record<"liner" | "closer" | "ftb" | "promoter", number>> = {};
  const previous = await tx.select({ role: salesCommissions.commissionRole, amount: salesCommissions.amount, ruleVersion: salesCommissions.ruleVersion }).from(salesCommissions).where(and(eq(salesCommissions.contractId, installment.contractId), ne(salesCommissions.status, "cancelled"), isNotNull(salesCommissions.sourceInstallmentId))).orderBy(asc(salesCommissions.id));
  previous.forEach(row => { alreadyReleased[row.role] = Math.round(((alreadyReleased[row.role] ?? 0) + Number(row.amount)) * 100) / 100; });
  const calendar = { cancellationDeadlineDay: policy.cancellationDeadlineDay, expectedPaymentDay: policy.expectedPaymentDay };
  const entryTotal = Number(context.proposal.downPaymentAmount);
  const v2Rows = async () => {
    // CRM-F2 (Codex P1): o V2 só dispara numa baixa ELEGÍVEL da ENTRADA — método dentro de eligiblePaymentMethods e parcela do cronograma de entrada. Saldo ou método inelegível seguram a comissão.
    // Retenção SEM silêncio: cada `return []` abaixo deixa auditoria idempotente (commission_v2_held), sem evento novo.
    const hold = async (reason: string, summary: string) => { await txAudit(tx as never, { actorUserId: null, entityType: "installment", entityId: installment.id, action: "commission_v2_held", summary, idempotencyKey: `commission-v2-held:${installment.id}:${reason}` }); return [] as never[]; };
    const schedulePolicy = policy.payoutSchedule;
    const releaseOnEntryTotal = (schedulePolicy?.mode ?? DEFAULT_PAYOUT_MODE) === "full_upfront" && (schedulePolicy?.releaseOn ?? DEFAULT_RELEASE_ON) === "entry_total";
    // Com entry_total (decisão 21/10/2026: entrada inteira recebida, QUALQUER forma de pagamento) o método da baixa que completa a entrada não retém: o que importa é o total pago.
    // Fora disso, método inelegível segue retido.
    if (!releaseOnEntryTotal && !policy.eligiblePaymentMethods.includes(input.paymentMethod as never)) return hold("payment_method_not_eligible", `Comissão V2 retida: o método "${input.paymentMethod}" não está entre os elegíveis da política.`);
    const fullSchedule = await tx.select({ id: installments.id, sequence: installments.sequence, amount: installments.amount, status: installments.status, dueDate: installments.dueDate, paidAmount: installments.paidAmount, paidAt: installments.paidAt }).from(installments).where(eq(installments.contractId, installment.contractId));
    const schedule = input.paidAsOf ? fullSchedule.map(row => paidAfter(row, installment.id, input.paidAsOf!) ? { ...row, status: "open", paidAmount: "0.00" } : row) : fullSchedule;
    const applied = await tx.select({ originalInstallmentId: installmentRenegotiations.originalInstallmentId, proposedAmount: installmentRenegotiations.proposedAmount, proposedDueDate: installmentRenegotiations.proposedDueDate }).from(installmentRenegotiations).where(and(eq(installmentRenegotiations.contractId, installment.contractId), eq(installmentRenegotiations.status, "applied"))).orderBy(asc(installmentRenegotiations.id));
    if (!entryInstallmentIds(schedule, entryTotal, applied).has(installment.id)) return hold("not_entry_installment", "Comissão V2 retida: a parcela baixada não faz parte da entrada (saldo não dispara comissão).");
    if (releaseOnEntryTotal && !isEntryFullyPaid(schedule, entryTotal, applied)) {
      return hold("entry_total_not_reached", `Comissão V2 retida: a entrada só libera quando o acumulado pago atinge ${entryTotal.toFixed(2)} (releaseOn = entry_total).`);
    }
    // Cotas da venda = frações vendidas ao contrato (mínimo 1: contrato sem fração ligada, ex. importado por CSV, conta uma cota).
    const [quotaRow] = await tx.select({ n: sql<number>`COUNT(*)` }).from(commercialFractions).where(eq(commercialFractions.currentContractId, installment.contractId));
    const result = computeCommissionV2(policy.rulesV2, { quotas: Math.max(1, Number(quotaRow?.n ?? 0)), entryCents: Math.round(entryTotal * 100), saleTotalCents: Math.round(Number(context.contract.totalAmount) * 100) });
    const capture = context.capture!;
    const roleMap = await commissionRoleMapForContract(tx, installment.contractId);
    const lines = result.lines.flatMap(line => {
      const role = roleMap[line.role];
      const userId = capture[V2_PAYEE[role]];
      return userId ? [{ role, userId, totalReais: line.amountCents / 100 }] : [];
    });
    return buildInstallmentCommissionsV2({ installmentId: installment.id, installmentAmount: Number(installment.amount), entryTotal, paymentMethod: input.paymentMethod, compensatedAt: input.compensatedAt, lines, alreadyReleased, calendar, payoutMode: policy.payoutSchedule?.mode ?? DEFAULT_PAYOUT_MODE });
  };
  // Versão fixada por contrato: a do primeiro lançamento automático ainda vigente. Liberar o V2 depois que o V1 já gerou comissão NÃO troca de regra no meio
  // do contrato (os totais não bateriam com nenhuma política). V2 fixado com o V2 travado de novo não gera nada: o travamento vence.
  const pinned = previous[0]?.ruleVersion as "v1" | "v2" | undefined;
  const useV2 = pinned ? pinned === "v2" : commissionV2Active(policy);
  if (useV2 && !commissionV2Active(policy)) {
    // Sem rastro a parcela paga ficava sem comissão e ninguém sabia reprocessar: registra skip auditável (mesmo evento do 0%), idempotente por parcela.
    await recordCommissionV2LockedSkip(tx, { installmentId: installment.id, contractId: installment.contractId, resortId: context.capture.resortId ?? null });
    return [];
  }
  const rows = (useV2 ? await v2Rows() : buildInstallmentCommissions({
    installmentId: installment.id, installmentAmount: Number(installment.amount), entryTotal,
    contractTotal: Number(context.contract.totalAmount), paymentMethod: input.paymentMethod, compensatedAt: input.compensatedAt,
    linerId: context.capture.linerId, closerId: context.capture.closerId,
    rates: { liner: policy.linerRate, closer: policy.closerRate, ftb: policy.ftbRate }, alreadyReleased, calendar,
  })).filter(row => !existingRoles.has(row.commissionRole));
  if (!rows.length) return [];
  const values = rows.map(row => ({ ...row, ruleVersion: useV2 ? "v2" : "v1", policyVersion: commissionPolicyVersionOf(policy), contractId: installment.contractId, opportunityId: context.opportunity?.id ?? null, campaignId: context.capture?.campaignId ?? null, baseAmount: row.baseAmount.toFixed(2), rate: row.rate.toFixed(2), amount: row.amount.toFixed(2), lifecycleStatus: row.lifecycleStatus, paymentMethod: row.paymentMethod }));
  const inserted = await tx.insert(salesCommissions).values(values).$returningId();
  const facts: CreatedCommissionFact[] = [];
  inserted.forEach((row, index) => { const value = values[index]; if (value && row?.id) facts.push({ id: row.id, sellerId: value.sellerId, campaignId: value.campaignId, opportunityId: value.opportunityId, contractId: value.contractId, sourceInstallmentId: value.sourceInstallmentId, commissionRole: value.commissionRole, amount: Number(value.amount), rate: Number(value.rate) });  });
  return facts;
}

/** Contrato já fixado no V2 e o V2 voltou a ficar travado: a parcela paga fica sem comissão, mas rastreável para `reprocessSkippedCommissions` quando liberar. */
async function recordCommissionV2LockedSkip(tx: CommissionWriter, input: { installmentId: number; contractId: number; resortId: number | null }) {
  const key = `commission-skipped:${input.installmentId}:${COMMISSION_V2_LOCKED_REASON}`;
  await txAudit(tx as never, { actorUserId: null, entityType: "installment", entityId: input.installmentId, action: "commission_skipped", summary: "Comissão automática não lançada: o contrato usa a regra V2 e o V2 está travado (COMMISSION_V2_RELEASED).", idempotencyKey: key });
  await txEvent(tx as never, { eventName: "commission.automatic.skipped", aggregateType: "installment", aggregateId: input.installmentId, actorUserId: null, payload: { contractId: input.contractId, installmentId: input.installmentId, resortId: input.resortId, reason: COMMISSION_V2_LOCKED_REASON, roles: [], source: "v2_locked" }, idempotencyKey: key });
}
