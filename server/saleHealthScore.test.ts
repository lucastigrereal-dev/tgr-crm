import { describe, expect, it } from "vitest";
import { calculateSaleHealth } from "../shared/saleHealthScore";

describe("calculateSaleHealth", () => {
  it("returns a healthy, explainable sale when facts are current", () => {
    const result = calculateSaleHealth({
      commercialStage: "won",
      contractStatus: "active",
      paidInstallments: 8,
      overdueInstallments: 0,
      totalInstallments: 10,
      documentCount: 5,
      requiredDocumentCount: 5,
      daysSinceLastInteraction: 2,
      openFollowUps: 0,
      cancellationRequested: false,
    });

    expect(result.band).toBe("healthy");
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.factors.length).toBeGreaterThan(4);
    expect(result.nextActions).toEqual([]);
  });

  it("prioritizes overdue payment, missing documents and stalled relationship", () => {
    const result = calculateSaleHealth({
      commercialStage: "proposal",
      contractStatus: "overdue",
      paidInstallments: 0,
      overdueInstallments: 2,
      totalInstallments: 12,
      documentCount: 1,
      requiredDocumentCount: 6,
      daysSinceLastInteraction: 45,
      openFollowUps: 3,
      cancellationRequested: true,
    });

    expect(result.band).toBe("critical");
    expect(result.nextActions.join(" ")).toContain("cobrança");
    expect(result.nextActions.join(" ")).toContain("documentos");
    expect(result.factors.some(factor => factor.key === "cancellation_requested")).toBe(true);
  });
});
