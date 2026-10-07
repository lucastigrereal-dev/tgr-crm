import { describe, expect, it } from "vitest";
import { buildInstallmentCommissions } from "./commissionAutomation";
import { commissionBlockReason } from "./installmentCommissions";
import { commissionPolicySchema } from "../shared/projectPolicySchemas";

const base = { installmentId: 1, installmentAmount: 1000, entryTotal: 1000, contractTotal: 11000, paymentMethod: "pix" as const, compensatedAt: new Date("2026-08-20T12:00:00Z"), linerId: 7, closerId: 8 };

describe("ADR-010 percentual por papel (default 0%)", () => {
  it("0% = nenhum lançamento (nada inventado)", () => {
    expect(buildInstallmentCommissions({ ...base, rates: { liner: 0, closer: 0, ftb: 0 } })).toEqual([]);
    expect(buildInstallmentCommissions({ ...base, linerId: 7, closerId: 7, rates: { ftb: 0 } })).toEqual([]);
  });
  it("papel sem taxa informada equivale a 0% e não bloqueia os demais papéis", () => {
    const rows = buildInstallmentCommissions({ ...base, rates: { closer: 0.02 } });
    expect(rows.map(row => row.commissionRole)).toEqual(["closer"]);
  });
  it("taxa > 0 em venda validada cria lançamento", () => {
    const rows = buildInstallmentCommissions({ ...base, rates: { liner: 0.01, closer: 0.02 } });
    expect(rows.map(row => [row.commissionRole, row.amount])).toEqual([["liner", 100], ["closer", 200]]);
  });
  it("política sem percentuais assume 0% por padrão", () => {
    const parsed = commissionPolicySchema.parse({ cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix"], basis: "eligible_receipt" });
    expect([parsed.linerRate, parsed.closerRate, parsed.ftbRate]).toEqual([0, 0, 0]);
  });
});

describe("ADR-010 gatilho: só venda VALIDADA", () => {
  const policy = { linerRate: 0.01 };
  it("VENDEU / pagamento confirmado sem validação final não gera lançamento", () => {
    expect(commissionBlockReason("active", policy, false)).toBe("sale_not_validated");
    expect(commissionBlockReason("pending_signature", policy, false)).toBe("sale_not_validated");
  });
  it("contrato ativo + venda validada libera", () => {
    expect(commissionBlockReason("active", policy, true)).toBeNull();
  });
});
