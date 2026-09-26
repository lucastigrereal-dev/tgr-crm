import { describe, expect, it } from "vitest";
import { buildMonetaryAdjustment, parseMonetaryAdjustmentPolicy } from "./monetaryAdjustment";

describe("motor de reajuste monetário", () => {
  it("compõe variações do índice e preserva memória por parcela", () => {
    const policy = parseMonetaryAdjustmentPolicy({ indexCode: "INCC", periodicityMonths: 6, spreadMonthlyPercent: 0, applyTo: "open_installments" });
    const result = buildMonetaryAdjustment({
      policy,
      baseDate: new Date("2026-01-01T12:00:00Z"),
      throughDate: new Date("2026-07-01T12:00:00Z"),
      indexValues: [
        { referenceDate: "2026-02-01", variationPercent: "0.50" },
        { referenceDate: "2026-03-01", variationPercent: "0.30" },
        { referenceDate: "2026-04-01", variationPercent: "-0.10" },
      ],
      installments: [
        { id: 1, sequence: 1, status: "open", amount: "1000.00" },
        { id: 2, sequence: 2, status: "overdue", amount: "500.00" },
      ],
    });
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.indexFactor).toBeCloseTo(1.0070035, 7);
    expect(result.beforeTotal).toBe(1500);
    expect(result.afterTotal).toBeGreaterThan(1500);
    expect(result.installments).toHaveLength(2);
    expect(result.installments[0]).toMatchObject({ id: 1, before: 1000 });
  });

  it("aplica spread mensal composto quando a política exige adicional mensal", () => {
    const policy = parseMonetaryAdjustmentPolicy({ indexCode: "IGPM", periodicityMonths: 1, spreadMonthlyPercent: 1, applyTo: "open_installments" });
    const result = buildMonetaryAdjustment({
      policy,
      baseDate: new Date("2026-01-01T12:00:00Z"),
      throughDate: new Date("2026-04-01T12:00:00Z"),
      indexValues: [],
      installments: [{ id: 3, sequence: 7, status: "open", amount: "1000.00" }],
    });
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.elapsedMonths).toBe(3);
    expect(result.spreadFactor).toBeCloseTo(1.030301, 6);
    expect(result.afterTotal).toBe(1030.3);
  });

  it("não aplica antes da periodicidade mínima", () => {
    const policy = parseMonetaryAdjustmentPolicy({ indexCode: "INCC", periodicityMonths: 6, spreadMonthlyPercent: 0, applyTo: "open_installments" });
    const result = buildMonetaryAdjustment({
      policy,
      baseDate: new Date("2026-01-01T12:00:00Z"),
      throughDate: new Date("2026-05-01T12:00:00Z"),
      indexValues: [],
      installments: [{ id: 4, sequence: 1, status: "open", amount: "100.00" }],
    });
    expect(result).toMatchObject({ eligible: false, reason: "periodicity_not_reached", elapsedMonths: 4, requiredMonths: 6 });
  });
});
