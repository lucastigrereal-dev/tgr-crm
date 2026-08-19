import { describe, expect, it } from "vitest";
import { buildCommercialCharts } from "./commercialMetrics";

describe("gráficos comerciais", () => {
  it("agrega funil e progresso por vendedor apenas com vendas ganhas no mês", () => {
    const chart = buildCommercialCharts([
      { stage: "new", expectedAmount: "1000.00", sellerId: 1, closedAt: null },
      { stage: "proposal", expectedAmount: "2500.00", sellerId: 1, closedAt: null },
      { stage: "won", expectedAmount: "5000.00", sellerId: 1, closedAt: new Date("2026-08-10T12:00:00Z") },
      { stage: "won", expectedAmount: "9000.00", sellerId: 1, closedAt: new Date("2026-07-30T12:00:00Z") },
      { stage: "won", expectedAmount: "3000.00", sellerId: 2, closedAt: new Date("2026-08-15T12:00:00Z") },
    ], [{ sellerId: 1, sellerName: "Ana", targetAmount: "10000.00", targetContracts: 2 }, { sellerId: 2, sellerName: "Bia", targetAmount: "6000.00", targetContracts: 1 }], new Date("2026-08-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
    expect(chart.funnel.find(item => item.stage === "proposal")).toMatchObject({ count: 1, amount: 2500 });
    expect(chart.goals).toEqual([{ sellerName: "Ana", targetAmount: 10000, currentAmount: 5000, targetContracts: 2, currentContracts: 1 }, { sellerName: "Bia", targetAmount: 6000, currentAmount: 3000, targetContracts: 1, currentContracts: 1 }]);
  });
});
