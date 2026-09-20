export type OpportunityStage = "new" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

const allowedTransitions: Record<OpportunityStage, readonly OpportunityStage[]> = {
  new: ["qualified", "proposal", "negotiation", "lost"],
  qualified: ["proposal", "negotiation", "lost"],
  proposal: ["negotiation", "lost"],
  negotiation: ["won", "lost"],
  won: [],
  lost: [],
};

export function canTransitionOpportunityStage(from: OpportunityStage, to: OpportunityStage): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

export function getAllowedOpportunityTransitions(from: OpportunityStage): readonly OpportunityStage[] {
  return allowedTransitions[from];
}
