import { describe, expect, it } from "vitest";
import { DEFAULT_REQUIRED_EVIDENCE, evidenceSatisfies, requiredEvidenceOf, strongerEvidence } from "./settlementEvidence";
import { salesCommandSaleSchema } from "./salesCommandBridge";

describe("CRM-H1: evidência do recebimento (puro)", () => {
  it("ordem receipt_claimed < gateway_confirmed < bank_reconciled", () => {
    expect(evidenceSatisfies("receipt_claimed", "receipt_claimed")).toBe(true);
    expect(evidenceSatisfies("receipt_claimed", "gateway_confirmed")).toBe(false);
    expect(evidenceSatisfies("bank_reconciled", "gateway_confirmed")).toBe(true);
    expect(strongerEvidence("gateway_confirmed", "receipt_claimed")).toBe("gateway_confirmed");
  });
  it("requiredEvidence da política: ausente, inválido ou JSON quebrado = receipt_claimed", () => {
    expect(DEFAULT_REQUIRED_EVIDENCE).toBe("receipt_claimed");
    expect(requiredEvidenceOf("{}")).toBe("receipt_claimed");
    expect(requiredEvidenceOf("{nao-json")).toBe("receipt_claimed");
    expect(requiredEvidenceOf({ requiredEvidence: "valor-invalido" })).toBe("receipt_claimed");
    expect(requiredEvidenceOf(JSON.stringify({ requiredEvidence: "bank_reconciled" }))).toBe("bank_reconciled");
  });
});

describe("CRM-H1: entrada declarada pelo Sales (alias)", () => {
  const base = (sale: Record<string, unknown>) => ({
    eventId: "evt-1", eventName: "sale.ready_for_contract.v1", source: "sales-command", correlationId: "corr-1", occurredAt: "2026-10-04T15:30:00.000Z",
    project: { externalKey: "p", name: "SYN", timezone: "America/Sao_Paulo" }, saleId: "sale-1", encounterId: "enc-1", customer: { name: "Casal SYN" },
    sale: { quotasCount: 1, vgvCents: 1000, entryContractedCents: 100, entryInstallmentCount: 1, entrySchedule: [{ sequence: 1, amountCents: 100, dueDate: "2026-10-04" }], firstBalanceDueInDays: 30, paymentMethods: ["pix"], ...sale },
  });
  it("aceita o nome novo, o antigo e os dois iguais; recusa divergentes e ausentes", () => {
    expect(salesCommandSaleSchema.parse(base({ entryReceiptClaimedCents: 50 })).sale.entryReceivedCents).toBe(50);
    expect(salesCommandSaleSchema.parse(base({ entryReceivedCents: 40 })).sale.entryReceivedCents).toBe(40);
    expect(salesCommandSaleSchema.parse(base({ entryReceivedCents: 40, entryReceiptClaimedCents: 40 })).sale.entryReceivedCents).toBe(40);
    expect(salesCommandSaleSchema.safeParse(base({ entryReceivedCents: 40, entryReceiptClaimedCents: 41 })).success).toBe(false);
    expect(salesCommandSaleSchema.safeParse(base({})).success).toBe(false);
  });
});
