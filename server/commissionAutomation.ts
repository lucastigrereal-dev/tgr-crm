import {
  commissionAssignments,
  commissionDates,
  commissionStatus,
  releasedCommission,
  type PaymentMethod,
} from "./commissionLifecycle";

export type CommissionRates = Partial<Record<"liner" | "closer" | "ftb", number>>;

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

  // Automatic commission must fail closed. Legacy rates are not a production fallback.
  if (
    assignments.some(
      (assignee) => typeof input.rates?.[assignee.role] !== "number",
    )
  ) {
    return [];
  }

  const base = Math.max(0, input.contractTotal - input.entryTotal);
  const dates = commissionDates(
    input.paymentMethod,
    input.compensatedAt,
    input.calendar,
  );

  return assignments.map((assignee) => {
    const rate = input.rates![assignee.role]!;
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
