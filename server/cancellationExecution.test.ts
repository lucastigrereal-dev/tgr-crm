import { describe, expect, it } from "vitest";
import { planCancellationExecution } from "./cancellationExecution";

describe("execução de distrato", () => {
  it("preserva parcelas e comissões pagas, cancelando somente impactos reversíveis", () => {
    expect(planCancellationExecution({ requestStatus: "approved", contractStatus: "active", installments: [{ id: 1, status: "paid" }, { id: 2, status: "open" }, { id: 3, status: "overdue" }, { id: 4, status: "renegotiated" }], commissions: [{ id: 11, status: "paid" }, { id: 12, status: "pending" }, { id: 13, status: "approved" }, { id: 14, status: "cancelled" }] })).toEqual({ cancelInstallmentIds: [2, 3, 4], preservedInstallmentIds: [1], cancelCommissionIds: [12, 13], preservedCommissionIds: [11] });
  });

  it("bloqueia solicitação não aprovada e reexecução de contrato já cancelado", () => {
    expect(() => planCancellationExecution({ requestStatus: "requested", contractStatus: "active", installments: [], commissions: [] })).toThrow("Somente distrato aprovado");
    expect(() => planCancellationExecution({ requestStatus: "approved", contractStatus: "cancelled", installments: [], commissions: [] })).toThrow("Contrato já está cancelado");
  });
});
