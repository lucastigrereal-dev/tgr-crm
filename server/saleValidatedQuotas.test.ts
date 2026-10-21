import { afterEach, describe, expect, it } from "vitest";
import { buildSaleValidatedBody, isQuotasCountValid, saleValidatedFactsFrom } from "./relationshipBridge";

// CRM-C4: quotasCount é ADITIVO no topo de crm.sale.validated.v1, opcional, inteiro 1..100000, atrás de SALE_VALIDATED_QUOTAS_COUNT_ENABLED.
const payload = {
  validatedAt: "2026-10-05T12:00:00.000Z", validatedBy: "1", paymentConfirmedAt: "2026-10-04T12:00:00.000Z", paymentConfirmedBy: "1",
  contractGeneratedAt: "2026-10-03T12:00:00.000Z", contractSignedAt: "2026-10-04T18:00:00.000Z", documentStoredAt: "2026-10-04T18:05:00.000Z", documentRef: "crm-doc:9001:77",
};
const lineage = { saleId: "s-1", projectExternalKey: "p", projectName: "P", projectTimezone: "America/Sao_Paulo", customerId: 1, customerName: "SYN" } as never;
const body = (facts: ReturnType<typeof saleValidatedFactsFrom>) => buildSaleValidatedBody(lineage, 9001, new Date("2026-10-05T12:00:00Z"), facts!) as Record<string, unknown>;

describe("CRM-C4 quotasCount", () => {
  afterEach(() => { delete process.env.SALE_VALIDATED_QUOTAS_COUNT_ENABLED; });
  it("flag desligada (padrão): o corpo sai exatamente como antes, sem quotasCount", () => {
    expect("quotasCount" in body(saleValidatedFactsFrom({ ...payload, quotasCount: 3 }))).toBe(false);
  });
  it("flag ligada: quotasCount sai no topo do corpo (fora de gates)", () => {
    process.env.SALE_VALIDATED_QUOTAS_COUNT_ENABLED = "true";
    const out = body(saleValidatedFactsFrom({ ...payload, quotasCount: 3 }));
    expect(out.quotasCount).toBe(3);
    expect((out.gates as Record<string, unknown>).quotasCount).toBeUndefined();
  });
  it("flag ligada mas valor ausente ou inválido: campo omitido, a venda não é recusada", () => {
    process.env.SALE_VALIDATED_QUOTAS_COUNT_ENABLED = "true";
    for (const bad of [undefined, 0, -1, 1.5, 100_001, "2", null, Number.NaN]) {
      const facts = saleValidatedFactsFrom({ ...payload, quotasCount: bad });
      expect(facts).not.toBeNull();
      expect("quotasCount" in body(facts)).toBe(false);
    }
  });
  it("limites 1 e 100000 são válidos", () => {
    expect(isQuotasCountValid(1)).toBe(true);
    expect(isQuotasCountValid(100_000)).toBe(true);
    expect(isQuotasCountValid(100_001)).toBe(false);
  });
});
