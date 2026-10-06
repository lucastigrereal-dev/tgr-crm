import { expect, it } from "vitest";
import { simulateCancellation } from "./cancellationDomain";

it("simula multa sobre pago com devolução após multa", () => { expect(simulateCancellation({ contractAmount: 10000, paidAmount: 2000, policy: { penaltyRate: 0.1, penaltyBase: "paid", refundMode: "after_penalty" } })).toMatchObject({ penalty: 200, refund: 1800, retained: 200 }); });
it("respeita retenção total configurada pelo empreendimento", () => { expect(simulateCancellation({ contractAmount: 10000, paidAmount: 2000, policy: { refundMode: "none" } }).refund).toBe(0); });
it("sem política configurada não inventa multa nem devolução (PRD Apêndice B #12, fail-closed)", () => {
  expect(simulateCancellation({ contractAmount: 10000, paidAmount: 2000, policy: {} })).toMatchObject({ penalty: null, refund: null, retained: null, policyConfigured: false, reason: "CANCELLATION_POLICY_MISSING", paidAmount: 2000 });
});
it("política configurada continua calculando e marca policyConfigured", () => {
  expect(simulateCancellation({ contractAmount: 10000, paidAmount: 2000, policy: { refundMode: "full" } })).toMatchObject({ refund: 2000, penalty: 0, policyConfigured: true, reason: null });
});
it("política parcial conta como não configurada (não completa com padrão inventado)", () => {
  for (const policy of [{ penaltyBase: "paid" as const }, { penaltyRate: 0 }, { penaltyRate: 0.1 }, { refundMode: "after_penalty" as const }]) {
    expect(simulateCancellation({ contractAmount: 10000, paidAmount: 2000, policy }).policyConfigured, JSON.stringify(policy)).toBe(false);
  }
  expect(simulateCancellation({ contractAmount: 10000, paidAmount: 2000, policy: { refundMode: "after_penalty", penaltyRate: 0.1 } }).policyConfigured).toBe(true);
});
