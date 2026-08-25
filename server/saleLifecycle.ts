export type SaleTruthStage =
  | "proposal_draft"
  | "proposal_accepted"
  | "contract_pending_signature"
  | "sale_validation_pending"
  | "sale_validated"
  | "payment_confirmed";

export type SaleFacts = {
  proposalAccepted?: boolean;
  contractCreatedAt?: Date | null;
  contractSignedAt?: Date | null;
  saleValidatedAt?: Date | null;
  paymentConfirmedAt?: Date | null;
};

/**
 * Derives the most advanced state supported by recorded facts.
 * Opportunity.stage is intentionally not used as proof of cash or validation.
 */
export function saleStageFromFacts(facts: SaleFacts): SaleTruthStage {
  if (facts.paymentConfirmedAt) return "payment_confirmed";
  if (facts.saleValidatedAt) return "sale_validated";
  if (facts.contractSignedAt) return "sale_validation_pending";
  if (facts.contractCreatedAt) return "contract_pending_signature";
  if (facts.proposalAccepted) return "proposal_accepted";
  return "proposal_draft";
}
