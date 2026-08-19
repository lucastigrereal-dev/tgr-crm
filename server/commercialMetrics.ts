export const funnelStages = ["new", "qualified", "proposal", "negotiation", "won", "lost"] as const;

type OpportunityMetric = { stage: string; expectedAmount: string | number; sellerId: number | null; closedAt: Date | null };
type GoalMetric = { sellerId: number; sellerName: string | null; targetAmount: string | number; targetContracts: number };

export function buildCommercialCharts(opportunities: OpportunityMetric[], goals: GoalMetric[], start: Date, end: Date) {
  const wonThisMonth = opportunities.filter(item => item.stage === "won" && item.closedAt && item.closedAt >= start && item.closedAt < end);
  return {
    funnel: funnelStages.map(stage => {
      const rows = opportunities.filter(item => item.stage === stage);
      return { stage, count: rows.length, amount: rows.reduce((sum, item) => sum + Number(item.expectedAmount), 0) };
    }),
    goals: goals.map(goal => {
      const rows = wonThisMonth.filter(item => item.sellerId === goal.sellerId);
      return { sellerName: goal.sellerName || "Vendedor", targetAmount: Number(goal.targetAmount), currentAmount: rows.reduce((sum, item) => sum + Number(item.expectedAmount), 0), targetContracts: goal.targetContracts, currentContracts: rows.length };
    }),
  };
}
