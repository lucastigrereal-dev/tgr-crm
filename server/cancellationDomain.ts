import type { ProjectCancellationPolicy } from "./projectPolicy";

const money = (value: number) => Math.round(Math.max(0, value) * 100) / 100;

export function simulateCancellation(input: { contractAmount: number; paidAmount: number; policy: ProjectCancellationPolicy }) {
  const base = input.policy.penaltyBase === "contract" ? input.contractAmount : input.paidAmount;
  const penalty = money(base * (input.policy.penaltyRate ?? 0));
  const refund = input.policy.refundMode === "none" ? 0 : input.policy.refundMode === "full" ? money(input.paidAmount) : money(Math.max(0, input.paidAmount - penalty));
  return { contractAmount: money(input.contractAmount), paidAmount: money(input.paidAmount), penaltyBase: input.policy.penaltyBase ?? "paid", penalty, refund, retained: money(Math.max(0, input.paidAmount - refund)) };
}
