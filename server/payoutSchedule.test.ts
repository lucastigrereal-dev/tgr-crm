import { describe, expect, it } from "vitest";
import { buildInstallmentCommissionsV2 } from "./commissionAutomation";
import { commissionPolicySchema, payoutScheduleSchema } from "../shared/projectPolicySchemas";

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

import { entryInstallmentIds, paidEntryAmount } from "./commissionAutomation";
describe("CRM-F2 correção: composição da entrada", () => {
  it("canceladas ficam fora do acumulado", () => {
    const schedule = [{ id: 1, sequence: 1, amount: "500.00", status: "cancelled" }, { id: 2, sequence: 2, amount: "1000.00", status: "open" }, { id: 3, sequence: 3, amount: "3000.00", status: "open" }];
    expect([...entryInstallmentIds(schedule, 1000)]).toEqual([2]);
  });
  it("renegociada ocupa a posição da original e a parcela do acordo herda a condição de entrada (sem somar de novo)", () => {
    const schedule = [
      { id: 1, sequence: 1, amount: "1000.00", status: "renegotiated", dueDate: "2026-10-10" },
      { id: 2, sequence: 2, amount: "3000.00", status: "open", dueDate: "2026-11-10" },
      { id: 3, sequence: 3, amount: "900.00", status: "open", dueDate: new Date("2026-12-01T12:00:00Z") },
    ];
    const reneg = [{ originalInstallmentId: 1, proposedAmount: "900.00", proposedDueDate: "2026-12-01" }];
    expect([...entryInstallmentIds(schedule, 1000, reneg)]).toEqual([3]);
    expect(isEntryInstallment(schedule, 2, 1000, reneg)).toBe(false);
    expect(isEntryInstallment(schedule, 1, 1000, reneg)).toBe(false);
  });
  it("renegociada sem parcela de acordo localizável fica fora (não vira entrada fantasma)", () => {
    const schedule = [{ id: 1, sequence: 1, amount: "1000.00", status: "renegotiated" }, { id: 2, sequence: 2, amount: "1000.00", status: "open" }];
    expect([...entryInstallmentIds(schedule, 1000)]).toEqual([2]);
  });
  it("acumulado pago da entrada soma só as parcelas da entrada com status paid", () => {
    const schedule = [{ id: 1, sequence: 1, amount: "500.00", status: "paid", paidAmount: "500.00" }, { id: 2, sequence: 2, amount: "500.00", status: "open", paidAmount: "0.00" }, { id: 3, sequence: 3, amount: "3000.00", status: "paid", paidAmount: "3000.00" }];
    expect(paidEntryAmount(schedule, 1000)).toBe(500);
  });
  it("P1: entrada parcial (R$100 pagos) renegociada: R$100 do ancestral + R$900 do sucessor pago libera o total", () => {
    const schedule = [
      { id: 1, sequence: 1, amount: "1000.00", status: "renegotiated", paidAmount: "100.00", dueDate: "2026-10-10" },
      { id: 2, sequence: 2, amount: "3000.00", status: "open", dueDate: "2026-11-10" },
      { id: 3, sequence: 3, amount: "900.00", status: "paid", paidAmount: "900.00", dueDate: "2026-12-01" },
    ];
    const reneg = [{ originalInstallmentId: 1, proposedAmount: "900.00", proposedDueDate: "2026-12-01" }];
    expect(paidEntryAmount(schedule, 1000, reneg)).toBe(1000);
  });
  it("P1: sucessor ainda aberto não libera (só o parcial do ancestral conta)", () => {
    const schedule = [
      { id: 1, sequence: 1, amount: "1000.00", status: "renegotiated", paidAmount: "100.00", dueDate: "2026-10-10" },
      { id: 3, sequence: 2, amount: "900.00", status: "open", paidAmount: "0.00", dueDate: "2026-12-01" },
    ];
    const reneg = [{ originalInstallmentId: 1, proposedAmount: "900.00", proposedDueDate: "2026-12-01" }];
    expect(paidEntryAmount(schedule, 1000, reneg)).toBe(100);
  });
  it("P2: 1 centavo acima da entrada fica fora (sem folga)", () => {
    const schedule = [{ id: 1, sequence: 1, amount: "500.00", status: "open" }, { id: 2, sequence: 2, amount: "500.01", status: "open" }];
    expect([...entryInstallmentIds(schedule, 1000)]).toEqual([1]);
    const exact = [{ id: 1, sequence: 1, amount: "500.00", status: "open" }, { id: 2, sequence: 2, amount: "500.00", status: "open" }];
    expect([...entryInstallmentIds(exact, 1000)]).toEqual([1, 2]);
  });
  it("releaseOn: aceita as duas opções com full_upfront e recusa com per_installment", () => {
    expect(payoutScheduleSchema.safeParse({ mode: "full_upfront", releaseOn: "entry_total" }).success).toBe(true);
    expect(payoutScheduleSchema.safeParse({ mode: "full_upfront", releaseOn: "first_entry_installment" }).success).toBe(true);
    expect(payoutScheduleSchema.safeParse({ mode: "per_installment", releaseOn: "entry_total" }).success).toBe(false);
    expect(payoutScheduleSchema.safeParse({ mode: "full_upfront", releaseOn: "x" }).success).toBe(false);
  });
});
