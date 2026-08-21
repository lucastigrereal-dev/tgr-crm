import { describe, expect, it } from "vitest";
import { buildCommercialIntegrityAlerts } from "./commercialIntegrity";

describe("commercial integrity alerts", () => {
  it("expõe comissão sem lastro, desconto irregular e documento pendente com prova e rota", () => {
    const alerts = buildCommercialIntegrityAlerts({
      commissions: [{ id: 1, contractId: 71, amount: 800, status: "approved", sourceInstallmentId: 701, sourceInstallmentStatus: "open" }],
      proposals: [{ id: 21, discountPercent: 15, allowedDiscountPercent: 10, approvalStatus: "pending" }],
      contracts: [{ id: 71, requiredDocuments: 3, approvedDocuments: 2 }],
      duplicateCandidates: [],
      opportunities: [],
    });
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "commission_without_entry", severity: "critical", ownerRole: "finance" }),
      expect.objectContaining({ code: "discount_without_approval", entityType: "proposal", ownerRole: "sales_manager" }),
      expect.objectContaining({ code: "missing_contract_documents", entityId: 71, ownerRole: "contracts" }),
    ]));
  });

  it("não faz acusação sem regra e trata duplicidade/reabertura como revisão humana", () => {
    const alerts = buildCommercialIntegrityAlerts({
      commissions: [{ id: 2, contractId: 72, amount: 200, status: "approved", sourceInstallmentId: 702, sourceInstallmentStatus: "paid" }],
      proposals: [{ id: 22, discountPercent: 10, allowedDiscountPercent: 10, approvalStatus: null }],
      contracts: [{ id: 72, requiredDocuments: 2, approvedDocuments: 2 }],
      duplicateCandidates: [{ customerId: 91, matchingFields: ["telefone", "nome semelhante"], confidence: "probable" }],
      opportunities: [{ id: 41, reopenCount: 2 }],
    });
    expect(alerts).toEqual([
      expect.objectContaining({ code: "probable_duplicate", severity: "medium", ownerRole: "revops" }),
      expect.objectContaining({ code: "reopened_opportunity", entityId: 41, severity: "medium" }),
    ]);
  });
});
