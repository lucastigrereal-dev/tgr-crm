export type PortfolioAssignmentFact = { contractId: number; ownerUserId: number; startsAt: Date };
export type PortfolioInstallmentFact = { contractId: number; amount: string | number; status: "open" | "paid" | "overdue" | "cancelled" | "renegotiated"; paidAt?: Date | null };
export type FinancialPortfolioScorecard = { ownerUserId: number; assignedContracts: number; openAmount: number; overdueAmount: number; recoveredAfterAssignment: number; regularizationRate: number | null; assignedSince: Date };

/**
 * Mérito financeiro começa na data de atribuição da carteira.
 * Pagamento anterior à posse não é “recuperação” do responsável atual.
 */
export function buildFinancialPortfolioScorecards(assignments: PortfolioAssignmentFact[], installments: PortfolioInstallmentFact[]): FinancialPortfolioScorecard[] {
  const byOwner = new Map<number, PortfolioAssignmentFact[]>();
  for (const assignment of assignments) { const ownerAssignments = byOwner.get(assignment.ownerUserId) ?? []; ownerAssignments.push(assignment); byOwner.set(assignment.ownerUserId, ownerAssignments); }
  return Array.from(byOwner.entries()).map(([ownerUserId, ownerAssignments]) => {
    const startByContract = new Map(ownerAssignments.map(assignment => [assignment.contractId, assignment.startsAt]));
    const scoped = installments.filter(installment => startByContract.has(installment.contractId));
    const openAmount = scoped.filter(installment => !["paid", "cancelled"].includes(installment.status)).reduce((sum, installment) => sum + Number(installment.amount), 0);
    const overdueAmount = scoped.filter(installment => installment.status === "overdue").reduce((sum, installment) => sum + Number(installment.amount), 0);
    const recoveredAfterAssignment = scoped.filter(installment => installment.status === "paid" && installment.paidAt && installment.paidAt >= startByContract.get(installment.contractId)!).reduce((sum, installment) => sum + Number(installment.amount), 0);
    const regularizationBase = recoveredAfterAssignment + openAmount;
    return { ownerUserId, assignedContracts: ownerAssignments.length, openAmount: Number(openAmount.toFixed(2)), overdueAmount: Number(overdueAmount.toFixed(2)), recoveredAfterAssignment: Number(recoveredAfterAssignment.toFixed(2)), regularizationRate: regularizationBase ? Number((recoveredAfterAssignment / regularizationBase * 100).toFixed(2)) : null, assignedSince: new Date(Math.min(...ownerAssignments.map(assignment => assignment.startsAt.getTime()))) };
  }).sort((left, right) => right.recoveredAfterAssignment - left.recoveredAfterAssignment || left.overdueAmount - right.overdueAmount);
}
