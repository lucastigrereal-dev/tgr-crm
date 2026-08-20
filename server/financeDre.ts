export type CampaignDreSource = {
  campaignId: number | null;
  campaignName: string | null;
  type: "income" | "expense";
  amount: string | number;
};

export type CampaignDre = {
  campaignId: number | null;
  campaignName: string;
  income: number;
  expense: number;
  result: number;
};

export function buildCampaignDre(rows: CampaignDreSource[]): CampaignDre[] {
  const groups = new Map<string, CampaignDre>();
  for (const row of rows) {
    const key = row.campaignId === null ? "unassigned" : String(row.campaignId);
    const existing = groups.get(key) ?? { campaignId: row.campaignId, campaignName: row.campaignName || "Sem campanha", income: 0, expense: 0, result: 0 };
    if (row.type === "income") existing.income += Number(row.amount); else existing.expense += Number(row.amount);
    existing.result = existing.income - existing.expense;
    groups.set(key, existing);
  }
  return Array.from(groups.values()).sort((a, b) => b.result - a.result || a.campaignName.localeCompare(b.campaignName, "pt-BR"));
}
