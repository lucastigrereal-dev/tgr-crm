export type CancellationInstallment = { id: number; status: "open" | "paid" | "overdue" | "cancelled" | "renegotiated" };
export type CancellationCommission = { id: number; status: "pending" | "approved" | "paid" | "cancelled" };

export function planCancellationExecution(input: { requestStatus: "requested" | "approved" | "rejected" | "executed" | "cancelled"; contractStatus: "draft" | "pending_signature" | "active" | "overdue" | "cancelled" | "closed"; installments: CancellationInstallment[]; commissions: CancellationCommission[] }) {
  if (input.requestStatus !== "approved") throw new Error("Somente distrato aprovado pode ser executado.");
  if (input.contractStatus === "cancelled") throw new Error("Contrato já está cancelado.");
  const cancelInstallmentIds = input.installments.filter(item => ["open", "overdue", "renegotiated"].includes(item.status)).map(item => item.id);
  const preservedInstallmentIds = input.installments.filter(item => item.status === "paid").map(item => item.id);
  const cancelCommissionIds = input.commissions.filter(item => item.status !== "paid" && item.status !== "cancelled").map(item => item.id);
  const preservedCommissionIds = input.commissions.filter(item => item.status === "paid").map(item => item.id);
  // ADR-010: comissão já paga não é estornada automaticamente; vai para a fila manual (gerente/financeiro), auditada.
  return { cancelInstallmentIds, preservedInstallmentIds, cancelCommissionIds, preservedCommissionIds, manualReviewCommissionIds: [...preservedCommissionIds] };
}
