import { describe, expect, it } from "vitest";
import { buildCommercialCharts, filterFunnelDetails } from "./commercialMetrics";

describe("gráficos comerciais", () => {
  it("agrega funil e progresso por vendedor apenas com vendas ganhas no período", () => {
    const chart = buildCommercialCharts([
      { stage: "new", expectedAmount: "1000.00", sellerId: 1, closedAt: null, createdAt: new Date("2026-08-02T12:00:00Z") },
      { stage: "proposal", expectedAmount: "2500.00", sellerId: 1, closedAt: null, createdAt: new Date("2026-08-05T12:00:00Z") },
      { stage: "won", expectedAmount: "5000.00", sellerId: 1, closedAt: new Date("2026-08-10T12:00:00Z"), createdAt: new Date("2026-08-01T12:00:00Z") },
      { stage: "won", expectedAmount: "9000.00", sellerId: 1, closedAt: new Date("2026-07-30T12:00:00Z"), createdAt: new Date("2026-07-01T12:00:00Z") },
      { stage: "won", expectedAmount: "3000.00", sellerId: 2, closedAt: new Date("2026-08-15T12:00:00Z"), createdAt: new Date("2026-08-01T12:00:00Z") },
    ], [{ sellerId: 1, sellerName: "Ana", targetAmount: "10000.00", targetContracts: 2, monthReference: "2026-08-01" }, { sellerId: 2, sellerName: "Bia", targetAmount: "6000.00", targetContracts: 1, monthReference: "2026-08-01" }], new Date("2026-08-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
    expect(chart.funnel.find(item => item.stage === "proposal")).toMatchObject({ count: 1, amount: 2500 });
    expect(chart.goals).toEqual([{ sellerName: "Ana", targetAmount: 10000, currentAmount: 5000, targetContracts: 2, currentContracts: 1 }, { sellerName: "Bia", targetAmount: 6000, currentAmount: 3000, targetContracts: 1, currentContracts: 1 }]);
  });

  it("filtra uma equipe específica sem misturar meta e venda dos demais", () => {
    const chart = buildCommercialCharts([{ stage: "won", expectedAmount: "3000", sellerId: 2, closedAt: new Date("2026-08-15T12:00:00Z"), createdAt: new Date("2026-08-01T12:00:00Z") }, { stage: "proposal", expectedAmount: "8000", sellerId: 1, closedAt: null, createdAt: new Date("2026-08-12T12:00:00Z") }], [{ sellerId: 1, sellerName: "Ana", targetAmount: "10000", targetContracts: 2, monthReference: "2026-08-01" }, { sellerId: 2, sellerName: "Bia", targetAmount: "6000", targetContracts: 1, monthReference: "2026-08-01" }], new Date("2026-08-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"), 2);
    expect(chart.goals).toEqual([{ sellerName: "Bia", targetAmount: 6000, currentAmount: 3000, targetContracts: 1, currentContracts: 1 }]);
    expect(chart.funnel.find(item => item.stage === "proposal")).toMatchObject({ count: 0, amount: 0 });
  });

  it("lista detalhes do funil apenas para a etapa, período e vendedor selecionados", () => {
    const rows = [
      { id: 1, stage: "proposal", expectedAmount: "1000", sellerId: 1, closedAt: null, createdAt: new Date("2026-08-05T12:00:00Z") },
      { id: 2, stage: "proposal", expectedAmount: "2000", sellerId: 2, closedAt: null, createdAt: new Date("2026-08-06T12:00:00Z") },
      { id: 3, stage: "negotiation", expectedAmount: "3000", sellerId: 1, closedAt: null, createdAt: new Date("2026-08-08T12:00:00Z") },
      { id: 4, stage: "proposal", expectedAmount: "4000", sellerId: 1, closedAt: null, createdAt: new Date("2026-07-28T12:00:00Z") },
    ];
    expect(filterFunnelDetails(rows, "proposal", new Date("2026-08-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"), 1).map(item => item.id)).toEqual([1]);
    expect(filterFunnelDetails(rows, "proposal", new Date("2026-08-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z")).map(item => item.id)).toEqual([1, 2]);
  });
});
