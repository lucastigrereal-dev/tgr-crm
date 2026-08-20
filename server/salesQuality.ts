export type SellerQualitySource = {
  sellerId: number | null;
  sellerName: string | null;
  stage: "new" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
  expectedAmount: string | number;
  nextFollowUpAt: Date | null;
};

export type SellerQuality = {
  sellerId: number;
  sellerName: string;
  qualityScore: number;
  conversionRate: number;
  followUpCompliance: number;
  wonCount: number;
  lostCount: number;
  openCount: number;
  overdueFollowUps: number;
  wonAmount: number;
};

export function buildSellerQualityRanking(rows: SellerQualitySource[], now = new Date()): SellerQuality[] {
  const groups = new Map<number, SellerQuality>();
  for (const row of rows) {
    if (!row.sellerId) continue;
    const item = groups.get(row.sellerId) ?? { sellerId: row.sellerId, sellerName: row.sellerName || `Vendedor #${row.sellerId}`, qualityScore: 0, conversionRate: 0, followUpCompliance: 100, wonCount: 0, lostCount: 0, openCount: 0, overdueFollowUps: 0, wonAmount: 0 };
    if (row.stage === "won") { item.wonCount += 1; item.wonAmount += Number(row.expectedAmount); }
    else if (row.stage === "lost") item.lostCount += 1;
    else { item.openCount += 1; if (!row.nextFollowUpAt || row.nextFollowUpAt.getTime() < now.getTime()) item.overdueFollowUps += 1; }
    groups.set(row.sellerId, item);
  }
  return Array.from(groups.values()).map(item => {
    const resolved = item.wonCount + item.lostCount;
    item.conversionRate = resolved ? Math.round((item.wonCount / resolved) * 100) : 0;
    item.followUpCompliance = item.openCount ? Math.round(((item.openCount - item.overdueFollowUps) / item.openCount) * 100) : 100;
    item.qualityScore = Math.round((resolved ? item.conversionRate * 0.6 : 0) + item.followUpCompliance * 0.4);
    return item;
  }).sort((a, b) => b.qualityScore - a.qualityScore || b.wonAmount - a.wonAmount || a.sellerName.localeCompare(b.sellerName, "pt-BR"));
}
