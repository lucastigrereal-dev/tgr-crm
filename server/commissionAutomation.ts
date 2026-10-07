import {
  commissionAssignments,
  commissionDates,
  commissionStatus,
  releasedCommission,
  type PaymentMethod,
} from "./commissionLifecycle";

export type CommissionRates = Partial<Record<"liner" | "closer" | "ftb", number>>;

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

  return payable.map((assignee) => {
    const rate = rateOf(assignee.role);
    const total = Math.round(base * rate * 100) / 100;
    const amount = releasedCommission(
      input.installmentAmount,
      input.entryTotal,
      total,
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
}

// PRD Apêndice B #17 (PILOTO V1) + ADR-007 (V6): comissão só pode virar devida com contrato ATIVO, política completa do
// empreendimento e VENDA VALIDADA (sale_validations.validatedAt). `saleValidated` é obrigatório de propósito: sem ele a
// comissão ficaria liberada por engano. Sem qualquer um, fica bloqueada (auditado como commission_blocked).
export function canCommissionBecomeDue(contractStatus: string | null | undefined, completePolicy: unknown, saleValidated: boolean): boolean {
  return Boolean(completePolicy) && contractStatus === "active" && saleValidated === true;
}
