import { expect, it } from "vitest";
import { buildInstallmentCommissions } from "./commissionAutomation";
import { commissionBlockReason } from "./installmentCommissions";
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

it("PRD Apêndice B #17 + ADR-007: comissão só vira devida com contrato ativo, política completa E venda validada", async () => {
  const { canCommissionBecomeDue } = await import("./commissionAutomation");
  const policy = parseCompleteCommissionPolicy(completePolicy);
  expect(canCommissionBecomeDue("active", policy, true)).toBe(true);
  for (const status of ["draft", "pending_signature", "overdue", "cancelled", "closed", null, undefined]) expect(canCommissionBecomeDue(status, policy, true), String(status)).toBe(false);
  expect(canCommissionBecomeDue("active", null, true)).toBe(false);
  // ADR-007: VENDEU / contrato gerado / pagamento confirmado ainda NÃO são venda validada.
  expect(canCommissionBecomeDue("active", policy, false)).toBe(false);
  for (const status of ["draft", "pending_signature"]) expect(canCommissionBecomeDue(status, policy, false), `${status} sem validação`).toBe(false);
  const { readFileSync } = await import("node:fs");
  for (const file of ["routers/finance.ts", "paymentGatewayWebhook.ts"]) {
    expect(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"), `${file} usa a regra única`).toMatch(/commissionBlockReason\([^)]*, [^)]*[sS]aleValidated[^)]*\)/);
  }
  // O motivo do bloqueio sai da MESMA regra: nulo exatamente quando canCommissionBecomeDue é verdadeiro.
  for (const status of ["draft", "pending_signature", "active", "overdue"]) for (const pol of [null, policy]) for (const validated of [false, true]) {
    expect(commissionBlockReason(status, pol, validated) === null, `${status}/${pol ? "policy" : "nopolicy"}/${validated}`).toBe(canCommissionBecomeDue(status, pol, validated));
  }
  expect(commissionBlockReason("active", policy, false)).toBe("sale_not_validated");
  expect(commissionBlockReason("pending_signature", null, false)).toBe("sale_not_validated");
  expect(commissionBlockReason("active", null, true)).toBe("incomplete_project_policy");
  expect(commissionBlockReason("overdue", policy, true)).toBe("contract_not_active");
});
