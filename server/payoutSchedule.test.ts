import { describe, expect, it } from "vitest";
import { buildInstallmentCommissionsV2 } from "./commissionAutomation";
import { commissionPolicySchema } from "../shared/projectPolicySchemas";

const common = { installmentId: 1, entryTotal: 1000, paymentMethod: "pix" as const, compensatedAt: new Date("2026-10-10T12:00:00Z") };
const lines = [{ role: "promoter" as const, userId: 5, totalReais: 800 }, { role: "liner" as const, userId: 6, totalReais: 100 }];

describe("CRM-F2: payoutSchedule", () => {
  it("full_upfront libera o total do papel de uma vez; per_installment segue proporcional; padrão da função pura = proporcional", () => {
    expect(buildInstallmentCommissionsV2({ ...common, installmentAmount: 500, lines, payoutMode: "full_upfront" }).map(row => row.amount)).toEqual([800, 100]);
    expect(buildInstallmentCommissionsV2({ ...common, installmentAmount: 500, lines, payoutMode: "per_installment" }).map(row => row.amount)).toEqual([400, 50]);
    expect(buildInstallmentCommissionsV2({ ...common, installmentAmount: 500, lines }).map(row => row.amount)).toEqual([400, 50]);
  });
  it("full_upfront nunca passa do total: o já liberado é descontado e a parcela seguinte não gera linha", () => {
    expect(buildInstallmentCommissionsV2({ ...common, installmentAmount: 500, lines, payoutMode: "full_upfront", alreadyReleased: { promoter: 300, liner: 100 } }).map(row => [row.commissionRole, row.amount])).toEqual([["promoter", 500]]);
    expect(buildInstallmentCommissionsV2({ ...common, installmentAmount: 500, lines, payoutMode: "full_upfront", alreadyReleased: { promoter: 800, liner: 100 } })).toEqual([]);
  });
  it("política aceita payoutSchedule válido e recusa modo desconhecido", () => {
    const base = { cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix"], basis: "eligible_receipt" };
    expect(commissionPolicySchema.safeParse({ ...base, payoutSchedule: { mode: "full_upfront" } }).success).toBe(true);
    expect(commissionPolicySchema.safeParse({ ...base, payoutSchedule: { mode: "semanal" } }).success).toBe(false);
    expect(commissionPolicySchema.safeParse(base).success).toBe(true);
  });
});

import { isEntryInstallment } from "./commissionAutomation";
describe("CRM-F2: parcela da entrada", () => {
  const schedule = [{ id: 1, sequence: 1, amount: "500.00" }, { id: 2, sequence: 2, amount: "500.00" }, { id: 3, sequence: 3, amount: "3000.00" }];
  it("o acumulado até a parcela precisa caber na entrada", () => {
    expect(isEntryInstallment(schedule, 1, 1000)).toBe(true);
    expect(isEntryInstallment(schedule, 2, 1000)).toBe(true);
    expect(isEntryInstallment(schedule, 3, 1000)).toBe(false);
    expect(isEntryInstallment(schedule, 99, 1000)).toBe(false);
  });
});
