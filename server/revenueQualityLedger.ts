export type LedgerFactType =
  | "vgv_formalized"
  | "cash_confirmed"
  | "cash_exposure"
  | "revenue_reversed"
  | "cancellation_retention"
  | "cancellation_refund"
  | "commission_expected"
  | "commission_at_risk"
  | "commission_paid"
  | "commission_reversed";

export type RevenueQualityLedgerFact = {
  type: LedgerFactType;
  amount: number;
  contractId: number;
  installmentId?: number;
  commissionId?: number;
  policyVersion: string;
  source: "contract" | "installment" | "commission" | "cancellation";
  reason?: "entry_not_confirmed" | "installment_overdue" | "contract_cancelled";
};

export type RevenueQualityLedgerInput = {
  contract: { id: number; totalAmount: number | string; status: "draft" | "pending_signature" | "active" | "overdue" | "cancelled" | "closed" };
  installments: Array<{ id: number; sequence: number; amount: number | string; status: "open" | "paid" | "overdue" | "cancelled" | "renegotiated" }>;
  commissions: Array<{ id: number; amount: number | string; status: "pending" | "approved" | "paid" | "cancelled"; lifecycleStatus: string; sourceInstallmentId?: number | null }>;
  cancellation?: { status: "requested" | "approved" | "rejected" | "executed" | "cancelled"; retentionAmount?: number | string; refundAmount?: number | string } | null;
  policyVersion: string;
};

const asMoney = (value: number | string | undefined) => Number(Number(value ?? 0).toFixed(2));

export function buildRevenueQualityLedger(input: RevenueQualityLedgerInput): RevenueQualityLedgerFact[] {
  const facts: RevenueQualityLedgerFact[] = [];
  const { contract, policyVersion } = input;
  const isFormalized = ["active", "overdue", "cancelled", "closed"].includes(contract.status);

  if (isFormalized) {
    facts.push({ type: "vgv_formalized", amount: asMoney(contract.totalAmount), contractId: contract.id, policyVersion, source: "contract" });
  }

  for (const installment of input.installments) {
    const base = { amount: asMoney(installment.amount), contractId: contract.id, installmentId: installment.id, policyVersion, source: "installment" as const };
    if (installment.status === "paid") facts.push({ ...base, type: "cash_confirmed" });
    if (["open", "overdue", "renegotiated"].includes(installment.status)) {
      facts.push({ ...base, type: "cash_exposure", reason: installment.status === "overdue" ? "installment_overdue" : undefined });
    }
  }

  if (contract.status === "cancelled") {
    facts.push({ type: "revenue_reversed", amount: asMoney(contract.totalAmount), contractId: contract.id, policyVersion, source: "contract", reason: "contract_cancelled" });
  }

  const installmentsById = new Map(input.installments.map(installment => [installment.id, installment]));
  for (const commission of input.commissions) {
    const base = { amount: asMoney(commission.amount), contractId: contract.id, commissionId: commission.id, policyVersion, source: "commission" as const };
    if (commission.status === "paid") {
      facts.push({ ...base, type: "commission_paid" });
      continue;
    }
    if (commission.status === "cancelled") {
      facts.push({ ...base, type: "commission_reversed", reason: "contract_cancelled" });
      continue;
    }

    facts.push({ ...base, type: "commission_expected" });
    const sourceInstallment = commission.sourceInstallmentId ? installmentsById.get(commission.sourceInstallmentId) : undefined;
    const reason = contract.status === "cancelled"
      ? "contract_cancelled"
      : sourceInstallment?.status === "overdue"
        ? "installment_overdue"
        : sourceInstallment?.status !== "paid"
          ? "entry_not_confirmed"
          : undefined;
    if (reason) facts.push({ ...base, type: "commission_at_risk", reason });
  }

  if (input.cancellation?.status === "executed") {
    if (asMoney(input.cancellation.retentionAmount) > 0) facts.push({ type: "cancellation_retention", amount: asMoney(input.cancellation.retentionAmount), contractId: contract.id, policyVersion, source: "cancellation" });
    if (asMoney(input.cancellation.refundAmount) > 0) facts.push({ type: "cancellation_refund", amount: asMoney(input.cancellation.refundAmount), contractId: contract.id, policyVersion, source: "cancellation" });
  }

  return facts;
}

export function summarizeRevenueQualityLedger(facts: RevenueQualityLedgerFact[]) {
  const sum = (type: LedgerFactType) => asMoney(facts.filter(fact => fact.type === type).reduce((total, fact) => total + fact.amount, 0));
  const vgvFormalized = sum("vgv_formalized");
  const revenueReversed = sum("revenue_reversed");
  return {
    vgvFormalized,
    cashConfirmed: sum("cash_confirmed"),
    cashExposure: sum("cash_exposure"),
    vgvLiquidRealized: asMoney(vgvFormalized - revenueReversed),
    commissionExpected: sum("commission_expected"),
    commissionAtRisk: sum("commission_at_risk"),
    commissionPaid: sum("commission_paid"),
    commissionReversed: sum("commission_reversed"),
    cancellationRetention: sum("cancellation_retention"),
    cancellationRefund: sum("cancellation_refund"),
  };
}
