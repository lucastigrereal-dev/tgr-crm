import { commissionAssignments, commissionDates, commissionStatus, releasedCommission, totalCommission, type PaymentMethod } from "./commissionLifecycle";

export function buildInstallmentCommissions(input: { installmentId: number; installmentAmount: number; entryTotal: number; contractTotal: number; paymentMethod: PaymentMethod; compensatedAt: Date; linerId: number | null; closerId: number | null }) {
  const base = Math.max(0, input.contractTotal - input.entryTotal); const dates = commissionDates(input.paymentMethod, input.compensatedAt);
  return commissionAssignments({ linerId: input.linerId, closerId: input.closerId }).map(assignee => { const total = totalCommission(base, assignee.role); const amount = releasedCommission(input.installmentAmount, input.entryTotal, total); return { sellerId: assignee.userId, commissionRole: assignee.role, sourceInstallmentId: input.installmentId, baseAmount: base, rate: total ? total / base * 100 : 0, amount, paymentMethod: input.paymentMethod, compensatedAt: input.compensatedAt, ...dates, lifecycleStatus: commissionStatus({ compensatedAt: input.compensatedAt, receivedAt: null, cancelledAt: null, ...dates, now: input.compensatedAt }) }; });
}
