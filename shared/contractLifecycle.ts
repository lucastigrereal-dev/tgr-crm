export type ContractStatus = "draft" | "pending_signature" | "active" | "overdue" | "cancelled" | "closed";

const allowedTransitions: Record<ContractStatus, readonly ContractStatus[]> = {
  draft: ["pending_signature", "active", "cancelled"],
  pending_signature: ["active", "cancelled"],
  active: ["overdue", "cancelled", "closed"],
  overdue: ["active", "cancelled", "closed"],
  cancelled: [],
  closed: [],
};

export function canTransitionContractStatus(from: ContractStatus, to: ContractStatus): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

export function getAllowedContractTransitions(from: ContractStatus): readonly ContractStatus[] {
  return allowedTransitions[from];
}
