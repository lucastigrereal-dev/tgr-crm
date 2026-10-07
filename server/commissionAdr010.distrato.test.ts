import { describe, expect, it } from "vitest";
import { planCancellationExecution } from "./cancellationExecution";

describe("ADR-010 distrato", () => {
  const plan = planCancellationExecution({ requestStatus: "approved", contractStatus: "active", installments: [], commissions: [{ id: 1, status: "pending" }, { id: 2, status: "approved" }, { id: 3, status: "paid" }, { id: 4, status: "cancelled" }] });
  it("comissão não paga é cancelada automaticamente", () => { expect(plan.cancelCommissionIds).toEqual([1, 2]); });
  it("comissão já paga NÃO é estornada: vai para fila manual", () => {
    expect(plan.preservedCommissionIds).toEqual([3]);
    expect(plan.manualReviewCommissionIds).toEqual([3]);
  });
});
