import { expect, it } from "vitest";
import { buildFinancialPortfolioScorecards } from "./financialPortfolioScorecard";

it("mede recuperação apenas após a atribuição e separa saldo de atraso", () => {
  const result = buildFinancialPortfolioScorecards([{ contractId: 1, ownerUserId: 7, startsAt: new Date("2026-08-10T12:00:00Z") }], [
    { contractId: 1, amount: "100.00", status: "paid", paidAt: new Date("2026-08-09T12:00:00Z") },
    { contractId: 1, amount: "200.00", status: "paid", paidAt: new Date("2026-08-12T12:00:00Z") },
    { contractId: 1, amount: "300.00", status: "overdue" },
    { contractId: 1, amount: "400.00", status: "open" },
  ]);
  expect(result).toEqual([expect.objectContaining({ ownerUserId: 7, assignedContracts: 1, recoveredAfterAssignment: 200, overdueAmount: 300, openAmount: 700, regularizationRate: 22.22 })]);
});
