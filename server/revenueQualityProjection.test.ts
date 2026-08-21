import { describe, expect, it } from "vitest";
import { buildPersistableRevenueProjection, revenueFactFingerprint } from "./revenueQualityProjection";

describe("revenue quality projection", () => {
  const input = {
    contract: { id: 44, totalAmount: "10000.00", status: "active" as const },
    installments: [{ id: 301, sequence: 1, amount: "2500.00", status: "paid" as const }, { id: 302, sequence: 2, amount: "7500.00", status: "open" as const }],
    commissions: [{ id: 601, amount: "500.00", status: "pending" as const, lifecycleStatus: "scheduled", sourceInstallmentId: 302 }],
    policyVersion: "revenue-quality-v1",
  };

  it("gera fingerprint estável para inserir uma vez e preservar origem/política", () => {
    const first = buildPersistableRevenueProjection(input, 8);
    const second = buildPersistableRevenueProjection(input, 8);
    expect(first).toEqual(second);
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "vgv_formalized", policyVersionId: 8 }),
      expect.objectContaining({ type: "cash_confirmed", installmentId: 301 }),
      expect.objectContaining({ type: "commission_at_risk", commissionId: 601, reason: "entry_not_confirmed" }),
    ]));
    expect(new Set(first.map(row => row.sourceFingerprint)).size).toBe(first.length);
  });

  it("muda o fingerprint quando o fato econômico ou a política mudam", () => {
    const fact = buildPersistableRevenueProjection(input)[0];
    expect(revenueFactFingerprint({ ...fact, policyVersion: "revenue-quality-v2" })).not.toBe(fact.sourceFingerprint);
    expect(revenueFactFingerprint({ ...fact, amount: 12000 })).not.toBe(fact.sourceFingerprint);
  });
});
