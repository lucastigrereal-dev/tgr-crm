import {
  commissionAssignments,
  commissionDates,
  commissionStatus,
  releasedCommission,
  type PaymentMethod,
} from "./commissionLifecycle";

export type CommissionRates = Partial<Record<"liner" | "closer" | "ftb", number>>;
export type CommissionRoleV2Mapped = "promoter" | "liner" | "closer";

// ADR-010: papel sem taxa (ou 0%) vale 0 e não gera lançamento.
export const commissionRoleRate = (rates: CommissionRates | undefined, role: "liner" | "closer" | "ftb") => {
  const rate = rates?.[role];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : 0;
};

export function buildInstallmentCommissions(input: {
  installmentId: number;
  installmentAmount: number;
  entryTotal: number;
  contractTotal: number;
  paymentMethod: PaymentMethod;
  compensatedAt: Date;
  linerId: number | null;
  closerId: number | null;
  rates?: CommissionRates;
  /** Issue #38 (1): acumulado já lançado (não cancelado) por papel neste contrato; limita o liberado ao total devido. */
  alreadyReleased?: Partial<Record<"liner" | "closer" | "ftb" | "promoter", number>>;
  calendar?: {
    cancellationDeadlineDay?: number;
    expectedPaymentDay?: number;
  };
}) {
  const assignments = commissionAssignments({
    linerId: input.linerId,
    closerId: input.closerId,
  });

  // ADR-010: percentual é parâmetro por papel com padrão 0%. Papel sem taxa (ou 0%) NÃO gera lançamento — nada é inventado.
  // Não há taxa histórica de fallback.
  const rateOf = (role: "liner" | "closer" | "ftb") => commissionRoleRate(input.rates, role);
  const payable = assignments.filter((assignee) => rateOf(assignee.role) > 0);
  if (!payable.length) return [];

  const base = Math.max(0, input.contractTotal - input.entryTotal);
  const dates = commissionDates(
    input.paymentMethod,
    input.compensatedAt,
    input.calendar,
  );

  const rows = payable.map((assignee) => {
    const rate = rateOf(assignee.role);
    const total = Math.round(base * rate * 100) / 100;
    const amount = releasedCommission(
      input.installmentAmount,
      input.entryTotal,
      total,
      input.alreadyReleased?.[assignee.role] ?? 0,
    );
    return {
      sellerId: assignee.userId,
      commissionRole: assignee.role,
      sourceInstallmentId: input.installmentId,
      baseAmount: base,
      rate: total && base > 0 ? (total / base) * 100 : rate * 100,
      amount,
      paymentMethod: input.paymentMethod,
      compensatedAt: input.compensatedAt,
      ...dates,
      lifecycleStatus: commissionStatus({
        compensatedAt: input.compensatedAt,
        receivedAt: null,
        cancelledAt: null,
        ...dates,
        now: input.compensatedAt,
      }),
    };
  });
  // Issue #38 (1): papel que já recebeu o total devido não ganha lançamento extra nas parcelas seguintes.
  return rows.filter((row) => !(row.amount <= 0 && (input.alreadyReleased?.[row.commissionRole] ?? 0) > 0));
}

// PRD Apêndice B #17 (PILOTO V1) + ADR-007 (V6): comissão só pode virar devida com contrato ATIVO, política completa do
// empreendimento e VENDA VALIDADA (sale_validations.validatedAt). `saleValidated` é obrigatório de propósito: sem ele a
// comissão ficaria liberada por engano. Sem qualquer um, fica bloqueada (auditado como commission_blocked).
/**
 * CRM-F2: a parcela pertence à ENTRADA quando o acumulado do cronograma (em ordem de sequência) até ela cabe no valor de entrada da proposta.
 * Sales guarda entrada e saldo juntos: baixar o saldo não pode disparar a comissão do V2.
 */
export function isEntryInstallment(schedule: Array<{ id: number; sequence: number; amount: string | number }>, installmentId: number, entryTotal: number) {
  let cumulative = 0;
  for (const item of [...schedule].sort((a, b) => a.sequence - b.sequence)) {
    cumulative = Math.round((cumulative + Number(item.amount)) * 100) / 100;
    if (item.id === installmentId) return cumulative <= Math.round(entryTotal * 100) / 100 + 0.005;
  }
  return false;
}

export function canCommissionBecomeDue(contractStatus: string | null | undefined, completePolicy: unknown, saleValidated: boolean): boolean {
  return Boolean(completePolicy) && contractStatus === "active" && saleValidated === true;
}

/**
 * CRM-A13: comissão por parcela pelas regras V2. O TOTAL de cada papel vem do motor puro (centavos -> reais) e a parcela libera a fração
 * dele na mesma proporção da entrada recebida (mesma `releasedCommission` do V1: nunca passa do total devido). Só é chamada com a política
 * V2 LIBERADA; travada, ninguém chama. Valor fixo por cota pode superar a entrada, então a taxa gravada (coluna decimal(5,2)) é limitada.
 */
export function buildInstallmentCommissionsV2(input: {
  installmentId: number;
  installmentAmount: number;
  entryTotal: number;
  paymentMethod: PaymentMethod;
  compensatedAt: Date;
  lines: Array<{ role: CommissionRoleV2Mapped; userId: number; totalReais: number }>;
  alreadyReleased?: Partial<Record<"liner" | "closer" | "ftb" | "promoter", number>>;
  calendar?: { cancellationDeadlineDay?: number; expectedPaymentDay?: number };
  /** CRM-F2: `full_upfront` libera o total do papel (menos o já liberado) de uma vez; `per_installment` (padrão desta função pura) é proporcional à parcela. */
  payoutMode?: "full_upfront" | "per_installment";
}) {
  const dates = commissionDates(input.paymentMethod, input.compensatedAt, input.calendar);
  const rows = input.lines.filter(line => line.totalReais > 0).map(line => {
    const total = Math.round(line.totalReais * 100) / 100;
    const amount = input.payoutMode === "full_upfront" && input.installmentAmount > 0 && input.entryTotal > 0
      ? Math.max(0, Math.round((total - (input.alreadyReleased?.[line.role] ?? 0)) * 100) / 100)
      : releasedCommission(input.installmentAmount, input.entryTotal, total, input.alreadyReleased?.[line.role] ?? 0);
    return {
      sellerId: line.userId,
      commissionRole: line.role,
      sourceInstallmentId: input.installmentId,
      baseAmount: input.entryTotal,
      rate: input.entryTotal > 0 ? Math.min(999.99, Math.round((total / input.entryTotal) * 10_000) / 100) : 0,
      amount,
      paymentMethod: input.paymentMethod,
      compensatedAt: input.compensatedAt,
      ...dates,
      lifecycleStatus: commissionStatus({ compensatedAt: input.compensatedAt, receivedAt: null, cancelledAt: null, ...dates, now: input.compensatedAt }),
    };
  });
  return rows.filter(row => !(row.amount <= 0 && (input.alreadyReleased?.[row.commissionRole] ?? 0) > 0));
}
