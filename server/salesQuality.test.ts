import { describe, expect, it } from "vitest";
import { buildSellerQualityRanking, visibleQualityRanking } from "./salesQuality";

describe("ranking de qualidade comercial", () => {
  it("combina conversão e higiene de follow-up, exibindo evidências sem inventar avaliação", () => {
    const ranking = buildSellerQualityRanking([
      { sellerId: 1, sellerName: "Ana", stage: "won", expectedAmount: "2000", nextFollowUpAt: null },
      { sellerId: 1, sellerName: "Ana", stage: "lost", expectedAmount: "1000", nextFollowUpAt: null },
      { sellerId: 1, sellerName: "Ana", stage: "proposal", expectedAmount: "800", nextFollowUpAt: new Date("2026-09-03T12:00:00Z") },
      { sellerId: 2, sellerName: "Bruno", stage: "won", expectedAmount: "1000", nextFollowUpAt: null },
      { sellerId: 2, sellerName: "Bruno", stage: "negotiation", expectedAmount: "700", nextFollowUpAt: new Date("2026-07-20T12:00:00Z") },
    ], new Date("2026-08-20T12:00:00Z"));
    expect(ranking).toEqual([
      expect.objectContaining({ sellerName: "Ana", conversionRate: 50, followUpCompliance: 100, qualityScore: 70, wonCount: 1, lostCount: 1, overdueFollowUps: 0, wonAmount: 2000 }),
      expect.objectContaining({ sellerName: "Bruno", conversionRate: 100, followUpCompliance: 0, qualityScore: 60, wonCount: 1, lostCount: 0, overdueFollowUps: 1, wonAmount: 1000 }),
    ]);
  });
});

describe("visibleQualityRanking (PRD Apêndice B #53)", () => {
  const rows = [{ sellerId: 1, sellerName: "SYN Ana" }, { sellerId: 2, sellerName: "SYN Bia" }];
  it("admin sees the whole operation", () => { expect(visibleQualityRanking(rows, { id: 9, role: "admin" })).toHaveLength(2); });
  it("a seller sees only their own row (no public individual ranking)", () => { expect(visibleQualityRanking(rows, { id: 2, role: "seller" })).toEqual([rows[1]]); });
  it("other roles see nothing but themselves", () => { expect(visibleQualityRanking(rows, { id: 7, role: "finance" })).toEqual([]); });
});
