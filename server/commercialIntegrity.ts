export type IntegrityAlertCode = "commission_without_entry" | "discount_without_approval" | "missing_contract_documents" | "probable_duplicate" | "reopened_opportunity";
export type IntegrityAlert = { code: IntegrityAlertCode; severity: "critical" | "high" | "medium"; entityType: "contract" | "proposal" | "customer" | "opportunity"; entityId: number; ownerRole: "finance" | "sales_manager" | "contracts" | "revops"; evidence: string };

export type CommercialIntegrityInput = {
  commissions: Array<{ id: number; contractId: number; amount: number; status: "pending" | "approved" | "paid" | "cancelled"; sourceInstallmentStatus?: "open" | "paid" | "overdue" | "cancelled" | null }>;
  proposals: Array<{ id: number; discountPercent: number; approvalStatus?: "pending" | "approved" | "rejected" | null; allowedDiscountPercent: number }>;
  contracts: Array<{ id: number; requiredDocuments: number; approvedDocuments: number }>;
  duplicateCandidates: Array<{ customerId: number; matchingFields: string[]; confidence: "high" | "probable" }>;
  opportunities: Array<{ id: number; reopenCount: number }>;
};

export function buildCommercialIntegrityAlerts(input: CommercialIntegrityInput): IntegrityAlert[] {
  const alerts: IntegrityAlert[] = [];
  input.commissions.forEach(commission => {
    if (["pending", "approved"].includes(commission.status) && commission.sourceInstallmentStatus !== "paid") alerts.push({ code: "commission_without_entry", severity: commission.status === "approved" ? "critical" : "high", entityType: "contract", entityId: commission.contractId, ownerRole: "finance", evidence: `Comissão ${commission.id} de R$ ${commission.amount.toFixed(2)} está ${commission.status} sem parcela-fonte paga.` });
  });
  input.proposals.forEach(proposal => {
    if (proposal.discountPercent > proposal.allowedDiscountPercent && proposal.approvalStatus !== "approved") alerts.push({ code: "discount_without_approval", severity: "high", entityType: "proposal", entityId: proposal.id, ownerRole: "sales_manager", evidence: `Desconto de ${proposal.discountPercent}% excede alçada de ${proposal.allowedDiscountPercent}% sem aprovação válida.` });
  });
  input.contracts.forEach(contract => {
    if (contract.approvedDocuments < contract.requiredDocuments) alerts.push({ code: "missing_contract_documents", severity: "high", entityType: "contract", entityId: contract.id, ownerRole: "contracts", evidence: `${contract.approvedDocuments}/${contract.requiredDocuments} documentos obrigatórios aprovados.` });
  });
  input.duplicateCandidates.forEach(candidate => {
    alerts.push({ code: "probable_duplicate", severity: candidate.confidence === "high" ? "high" : "medium", entityType: "customer", entityId: candidate.customerId, ownerRole: "revops", evidence: `Possível duplicidade por ${candidate.matchingFields.join(", ")}.` });
  });
  input.opportunities.forEach(opportunity => {
    if (opportunity.reopenCount >= 2) alerts.push({ code: "reopened_opportunity", severity: "medium", entityType: "opportunity", entityId: opportunity.id, ownerRole: "revops", evidence: `Oportunidade reaberta ${opportunity.reopenCount} vezes.` });
  });
  return alerts;
}
