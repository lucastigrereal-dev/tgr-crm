import { expect, it } from "vitest";
import { buildInstallmentCommissions } from "./commissionAutomation";
import { parseCompleteCommissionPolicy } from "./projectPolicy";

const completePolicy = JSON.stringify({
  linerRate: 0.02,
  closerRate: 0.03,
  ftbRate: 0.04,
  cancellationDeadlineDay: 7,
  expectedPaymentDay: 25,
  eligiblePaymentMethods: ["pix", "boleto"],
  basis: "eligible_receipt",
});

it("recusa política ausente, parcial ou inválida para comissão automática", () => {
  expect(parseCompleteCommissionPolicy(undefined)).toBeNull();
  expect(parseCompleteCommissionPolicy('{"ftbRate":0.04}')).toBeNull();
  expect(parseCompleteCommissionPolicy('{"ftbRate":"4%"}')).toBeNull();
});

it("aceita somente política completa e explícita", () => {
  expect(parseCompleteCommissionPolicy(completePolicy)).toMatchObject({
    linerRate: 0.02,
    closerRate: 0.03,
    ftbRate: 0.04,
    basis: "eligible_receipt",
  });
});

it("não gera comissão automática com política incompleta", () => {
  const rows = buildInstallmentCommissions({
    installmentId: 10,
    installmentAmount: 1_000,
    entryTotal: 1_000,
    contractTotal: 11_000,
    paymentMethod: "pix",
    compensatedAt: new Date("2026-08-20T12:00:00Z"),
    linerId: 7,
    closerId: 7,
    rates: { ftb: undefined },
  });
  expect(rows).toEqual([]);
});
