export const funnelStages = ["new", "qualified", "proposal", "negotiation", "won", "lost"] as const;

type OpportunityMetric = { stage: string; expectedAmount: string | number; sellerId: number | null; campaignId?: number | null; closedAt: Date | null; createdAt: Date };
type GoalMetric = { sellerId: number; sellerName: string | null; targetAmount: string | number; targetContracts: number; monthReference: Date | string };
type CaptureLinkMetric = { opportunityId: number | null; createdAt: Date };

export function latestCaptureByOpportunity<T extends CaptureLinkMetric>(captures?: T[] | null) {
  const selected = new Map<number, T>();
  const rows = Array.isArray(captures) ? captures : [];
  for (const capture of rows) {
    if (!capture.opportunityId) continue;
    const current = selected.get(capture.opportunityId);
    if (!current || capture.createdAt.getTime() > current.createdAt.getTime()) selected.set(capture.opportunityId, capture);
  }
  return selected;
}

const withinRange = (value: Date | string | null, start: Date, end: Date) => {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(`${value}T12:00:00Z`);
  return date >= start && date < end;
};

export function filterFunnelDetails<T extends OpportunityMetric>(opportunities: T[], stage: string, start: Date, end: Date, sellerId?: number, campaignId?: number) {
  return opportunities.filter(item => item.stage === stage && (!sellerId || item.sellerId === sellerId) && (!campaignId || item.campaignId === campaignId) && withinRange(item.closedAt ?? item.createdAt, start, end));
}

export function buildCommercialCharts(opportunities: OpportunityMetric[], goals: GoalMetric[], start: Date, end: Date, sellerId?: number, campaignId?: number) {
  const selectedOpportunities = opportunities.filter(item => (!sellerId || item.sellerId === sellerId) && (!campaignId || item.campaignId === campaignId));
  const periodOpportunities = selectedOpportunities.filter(item => withinRange(item.closedAt ?? item.createdAt, start, end));
  const wonInPeriod = selectedOpportunities.filter(item => item.stage === "won" && withinRange(item.closedAt, start, end));
  const selectedGoals = goals.filter(goal => (!sellerId || goal.sellerId === sellerId) && withinRange(goal.monthReference, start, end));
  return {
    funnel: funnelStages.map(stage => {
      const rows = periodOpportunities.filter(item => item.stage === stage);
      return { stage, count: rows.length, amount: rows.reduce((sum, item) => sum + Number(item.expectedAmount), 0) };
    }),
    goals: selectedGoals.map(goal => {
      const rows = wonInPeriod.filter(item => item.sellerId === goal.sellerId);
      return { sellerName: goal.sellerName || "Vendedor", targetAmount: Number(goal.targetAmount), currentAmount: rows.reduce((sum, item) => sum + Number(item.expectedAmount), 0), targetContracts: goal.targetContracts, currentContracts: rows.length };
    }),
  };
}
