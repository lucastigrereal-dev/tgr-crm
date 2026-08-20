import { describe, expect, it } from "vitest";
import { buildCampaignDre } from "./financeDre";

describe("DRE de caixa por campanha", () => {
  it("separa receita, despesa e resultado por campanha sem esconder lançamentos sem atribuição", () => {
    const dre = buildCampaignDre([
      { campaignId: 1, campaignName: "Verão", type: "income", amount: "1000.00" },
      { campaignId: 1, campaignName: "Verão", type: "expense", amount: "250.40" },
      { campaignId: 2, campaignName: "Família", type: "income", amount: "500.00" },
      { campaignId: null, campaignName: null, type: "expense", amount: "70.00" },
    ]);
    expect(dre).toEqual([
      { campaignId: 1, campaignName: "Verão", income: 1000, expense: 250.4, result: 749.6 },
      { campaignId: 2, campaignName: "Família", income: 500, expense: 0, result: 500 },
      { campaignId: null, campaignName: "Sem campanha", income: 0, expense: 70, result: -70 },
    ]);
  });
});
