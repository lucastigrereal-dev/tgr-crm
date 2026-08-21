import { describe, expect, it } from "vitest";
import { buildRevenueQualityLedger, summarizeRevenueQualityLedger } from "./revenueQualityLedger";

describe("revenue quality ledger", () => {
  it("separa VGV formalizado, caixa confirmado e comissão exposta sem confundir promessa com dinheiro", () => {
    const facts = buildRevenueQualityLedger({
      contract: { id: 71, totalAmount: "10000.00", status: "active" },
      installments: [
        { id: 1, sequence: 1, amount: "2000.00", status: "paid" },
        { id: 2, sequence: 2, amount: "8000.00", status: "open" },
      ],
      commissions: [
        { id: 31, amount: "200.00", status: "approved", lifecycleStatus: "expected", sourceInstallmentId: 1 },
        { id: 32, amount: "800.00", status: "pending", lifecycleStatus: "expected", sourceInstallmentId: 2 },
      ],
      policyVersion: "resort-1/commission/2026-08",
    });

    expect(summarizeRevenueQualityLedger(facts)).toMatchObject({ vgvFormalized: 10000, cashConfirmed: 2000, cashExposure: 8000, vgvLiquidRealized: 10000, commissionExpected: 1000, commissionAtRisk: 800, commissionPaid: 0 });
    expect(facts).toContainEqual(expect.objectContaining({ type: "commission_at_risk", commissionId: 32, reason: "entry_not_confirmed", policyVersion: "resort-1/commission/2026-08" }));
    expect(facts).not.toContainEqual(expect.objectContaining({ type: "commission_at_risk", commissionId: 31 }));
  });

  it("preserva os fatos da venda e acrescenta reversão, retenção, reembolso e estorno no distrato executado", () => {
    const facts = buildRevenueQualityLedger({
      contract: { id: 72, totalAmount: 10000, status: "cancelled" },
      installments: [{ id: 3, sequence: 1, amount: 2000, status: "paid" }, { id: 4, sequence: 2, amount: 8000, status: "cancelled" }],
      commissions: [{ id: 33, amount: 200, status: "paid", lifecycleStatus: "paid", sourceInstallmentId: 3 }, { id: 34, amount: 800, status: "cancelled", lifecycleStatus: "cancelled", sourceInstallmentId: 4 }],
      cancellation: { status: "executed", retentionAmount: 120, refundAmount: 80 },
      policyVersion: "resort-1/cancellation/2026-08",
    });

    expect(summarizeRevenueQualityLedger(facts)).toMatchObject({ vgvFormalized: 10000, vgvLiquidRealized: 0, cashConfirmed: 2000, commissionPaid: 200, commissionReversed: 800, cancellationRetention: 120, cancellationRefund: 80 });
    expect(facts).toContainEqual(expect.objectContaining({ type: "revenue_reversed", amount: 10000, reason: "contract_cancelled" }));
    expect(facts).toContainEqual(expect.objectContaining({ type: "cancellation_refund", amount: 80 }));
  });
});
