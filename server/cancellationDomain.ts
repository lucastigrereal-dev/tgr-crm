import type { ProjectCancellationPolicy } from "./projectPolicy";

const money = (value: number) => Math.round(Math.max(0, value) * 100) / 100;

// PRD Apêndice B #12 (ABERTO): sem política de distrato configurada no empreendimento, o sistema NÃO inventa multa
// nem devolução (antes: multa 0 e devolução integral, gravadas no financeiro). O distrato pode ser executado; os valores
// ficam nulos com o motivo, e a execução não gera lançamento financeiro.
export const CANCELLATION_POLICY_MISSING = "CANCELLATION_POLICY_MISSING" as const;

export function isCancellationPolicyConfigured(policy: ProjectCancellationPolicy) {
  return Object.values(policy).some(value => value !== undefined && value !== null);
}

export function simulateCancellation(input: { contractAmount: number; paidAmount: number; policy: ProjectCancellationPolicy }) {
  if (!isCancellationPolicyConfigured(input.policy)) {
    return { contractAmount: money(input.contractAmount), paidAmount: money(input.paidAmount), penaltyBase: null, penalty: null, refund: null, retained: null, policyConfigured: false as const, reason: CANCELLATION_POLICY_MISSING };
  }
  const base = input.policy.penaltyBase === "contract" ? input.contractAmount : input.paidAmount;
  const penalty = money(base * (input.policy.penaltyRate ?? 0));
  const refund = input.policy.refundMode === "none" ? 0 : input.policy.refundMode === "full" ? money(input.paidAmount) : money(Math.max(0, input.paidAmount - penalty));
  return { contractAmount: money(input.contractAmount), paidAmount: money(input.paidAmount), penaltyBase: input.policy.penaltyBase ?? "paid", penalty, refund, retained: money(Math.max(0, input.paidAmount - refund)), policyConfigured: true as const, reason: null };
}
