import { createHash } from "node:crypto";
import { buildRevenueQualityLedger, type RevenueQualityLedgerFact, type RevenueQualityLedgerInput } from "./revenueQualityLedger";

export type PersistableRevenueQualityFact = RevenueQualityLedgerFact & {
  policyVersionId?: number;
  sourceFingerprint: string;
};

export function revenueFactFingerprint(fact: RevenueQualityLedgerFact) {
  const source = [fact.contractId, fact.installmentId ?? "-", fact.commissionId ?? "-", fact.type, fact.amount.toFixed(2), fact.policyVersion, fact.source, fact.reason ?? "-"].join("|");
  return createHash("sha256").update(source).digest("hex");
}

export function buildPersistableRevenueProjection(input: RevenueQualityLedgerInput, policyVersionId?: number): PersistableRevenueQualityFact[] {
  return buildRevenueQualityLedger(input).map(fact => ({ ...fact, policyVersionId, sourceFingerprint: revenueFactFingerprint(fact) }));
}
