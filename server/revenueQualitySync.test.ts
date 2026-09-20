import { describe, expect, it } from "vitest";
import { revenueQualitySyncIdempotencyKey } from "./revenueQualitySync";

describe("revenue quality sync idempotency", () => {
  it("mantém a mesma chave quando o estado projetado é o mesmo", () => {
    const first = revenueQualitySyncIdempotencyKey({ contractId: 44, policyVersion: "revenue_quality/v1", sourceFingerprints: ["fact-b", "fact-a"] });
    const retry = revenueQualitySyncIdempotencyKey({ contractId: 44, policyVersion: "revenue_quality/v1", sourceFingerprints: ["fact-a", "fact-b"] });

    expect(retry).toBe(first);
    expect(first).toMatch(/^revenue_quality_sync:44:[a-f0-9]{64}$/);
  });

  it.each([
    { contractId: 45, policyVersion: "revenue_quality/v1", sourceFingerprints: ["fact-a", "fact-b"] },
    { contractId: 44, policyVersion: "revenue_quality/v2", sourceFingerprints: ["fact-a", "fact-b"] },
    { contractId: 44, policyVersion: "revenue_quality/v1", sourceFingerprints: ["fact-a", "fact-c"] },
  ])("muda a chave quando a projeção muda: %#", input => {
    const original = revenueQualitySyncIdempotencyKey({ contractId: 44, policyVersion: "revenue_quality/v1", sourceFingerprints: ["fact-a", "fact-b"] });

    expect(revenueQualitySyncIdempotencyKey(input)).not.toBe(original);
  });
});
