import { expect, it } from "vitest";
import { buildInstallmentCommissions } from "./commissionAutomation";

it("não usa taxa histórica quando a política não é informada", () => {
  expect(
    buildInstallmentCommissions({
      installmentId: 99,
      installmentAmount: 1_000,
      entryTotal: 1_000,
      contractTotal: 11_000,
      paymentMethod: "pix",
      compensatedAt: new Date("2026-08-20T12:00:00Z"),
      linerId: 7,
      closerId: 7,
    }),
  ).toEqual([]);
});
it("gera uma linha FTB proporcional quando a fixture informa a taxa", () => { const rows = buildInstallmentCommissions({ installmentId: 8, installmentAmount: 2_000, entryTotal: 8_000, contractTotal: 100_000, paymentMethod: "pix", compensatedAt: new Date("2026-08-10T12:00:00Z"), linerId: 5, closerId: 5, rates: { ftb: 0.0342 } }); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ sellerId: 5, commissionRole: "ftb", sourceInstallmentId: 8, amount: 786.6, lifecycleStatus: "closing" }); });
it("prioriza taxa configurada pelo empreendimento", () => { const rows = buildInstallmentCommissions({ installmentId: 1, installmentAmount: 1000, entryTotal: 1000, contractTotal: 11000, paymentMethod: "pix", compensatedAt: new Date("2026-08-20T12:00:00Z"), linerId: 7, closerId: 7, rates: { ftb: 0.04 } }); expect(rows[0]?.amount).toBe(400); });
it("aplica calendário configurado pelo empreendimento", () => { const rows = buildInstallmentCommissions({ installmentId: 1, installmentAmount: 1000, entryTotal: 1000, contractTotal: 11000, paymentMethod: "pix", compensatedAt: new Date("2026-08-20T12:00:00Z"), linerId: 7, closerId: 7, rates: { ftb: 0.04 }, calendar: { cancellationDeadlineDay: 10, expectedPaymentDay: 20 } }); expect(rows[0]?.cancellationDeadlineAt.toISOString().slice(0, 10)).toBe("2026-09-10"); expect(rows[0]?.expectedPaymentAt.toISOString().slice(0, 10)).toBe("2026-09-20"); });
