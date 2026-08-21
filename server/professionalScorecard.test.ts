import { describe, expect, it } from "vitest";
import { buildProfessionalScorecards } from "./professionalScorecard";

describe("professional scorecard", () => {
  it("mantém FTB exclusivo e não duplica liner/closer da mesma pessoa na mesma venda", () => {
    const cards = buildProfessionalScorecards([
      { saleId: 1, userId: 7, role: "liner", vgvFormalized: 10000, cashConfirmed: 2000, lifecycle: "matured" },
      { saleId: 1, userId: 7, role: "closer", vgvFormalized: 10000, cashConfirmed: 2000, lifecycle: "matured" },
      { saleId: 1, userId: 7, role: "ftb", vgvFormalized: 10000, cashConfirmed: 2000, lifecycle: "matured" },
    ]);
    expect(cards).toEqual([expect.objectContaining({ userId: 7, role: "ftb", attributedSales: 1, vgvFormalized: 10000, cashConfirmed: 2000 })]);
  });

  it("expõe maturação e taxa de cancelamento sem fabricar ranking com amostra pequena", () => {
    const [card] = buildProfessionalScorecards([
      { saleId: 1, userId: 8, role: "closer", vgvFormalized: 10000, cashConfirmed: 2000, lifecycle: "matured" },
      { saleId: 2, userId: 8, role: "closer", vgvFormalized: 11000, cashConfirmed: 0, lifecycle: "cancelled" },
      { saleId: 3, userId: 8, role: "closer", vgvFormalized: 12000, cashConfirmed: 0, lifecycle: "new" },
    ], 10);
    expect(card).toMatchObject({ attributedSales: 3, maturedSales: 2, cancelledMaturedSales: 1, cancellationRate: 50, coverage: "maturing" });
  });
});
