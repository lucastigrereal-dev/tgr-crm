import { describe, expect, it } from "vitest";
import { borderoSummary, commissionAssignments, commissionDates, commissionStatus, releasedCommission, roundMoney, toCents, totalCommission } from "./commissionLifecycle";

describe("commission lifecycle", () => {
  it("calcula regra por papel e libera a comissão na proporção da entrada", () => { expect(totalCommission(100_000, "liner", 0.0191)).toBe(1910); expect(totalCommission(100_000, "closer", 0.0151)).toBe(1510); expect(totalCommission(100_000, "ftb", 0.0342)).toBe(3420); expect(releasedCommission(2_000, 8_000, 1_000)).toBe(250); });
  it("trata Front Back como papel único e não soma liner com fechador", () => { expect(commissionAssignments({ linerId: 9, closerId: 9 })).toEqual([{ userId: 9, role: "ftb" }]); expect(commissionAssignments({ linerId: 9, closerId: 12 })).toEqual([{ userId: 9, role: "liner" }, { userId: 12, role: "closer" }]); });
  it("fecha crédito no mês seguinte e aplica dias 7 e 25", () => { const dates = commissionDates("credit", new Date("2026-08-13T12:00:00Z")); expect(dates.closingAt.toISOString()).toContain("2026-09-30"); expect(dates.cancellationDeadlineAt.toISOString()).toContain("2026-10-07"); expect(dates.expectedPaymentAt.toISOString()).toContain("2026-10-25"); });
  it("prioriza pagamento, bloqueia cancelamento na janela e consolida borderô", () => { const dates = commissionDates("pix", new Date("2026-08-13T12:00:00Z")); const cancelled = commissionStatus({ compensatedAt: new Date("2026-08-13T12:00:00Z"), receivedAt: null, cancelledAt: new Date("2026-09-05T12:00:00Z"), ...dates, now: new Date("2026-09-06T12:00:00Z") }); const paid = commissionStatus({ compensatedAt: new Date("2026-08-13T12:00:00Z"), receivedAt: new Date("2026-09-25T12:00:00Z"), cancelledAt: null, ...dates, now: new Date("2026-09-25T12:00:00Z") }); expect(cancelled).toBe("cancelled"); expect(paid).toBe("paid"); expect(borderoSummary([{ amount: 100, status: cancelled, expectedPaymentAt: dates.expectedPaymentAt }, { amount: 50, status: paid, expectedPaymentAt: dates.expectedPaymentAt }])).toMatchObject({ expected: 150, cancelled: 100, paid: 50, installments: 2 }); });
});

describe("issue #38 (1): proração com teto", () => {
  it("parcelas além da entrada não liberam mais que o total devido (cenário do red team)", () => {
    const total = totalCommission(9_000, "closer", 0.03); // base 9000, closer 3% = 270
    const entry = releasedCommission(1_000, 1_000, total, 0);
    expect(entry).toBe(270);
    expect(releasedCommission(4_500, 1_000, total, entry)).toBe(0);
    expect(releasedCommission(4_500, 1_000, total, entry + 0)).toBe(0);
  });
  it("entrada parcelada libera proporcionalmente e a soma nunca passa do total", () => {
    const total = 1_000;
    const a = releasedCommission(2_000, 8_000, total, 0);
    const b = releasedCommission(6_000, 8_000, total, a);
    const c = releasedCommission(5_000, 8_000, total, a + b);
    expect([a, b]).toEqual([250, 750]);
    expect(c).toBe(0);
    expect(a + b + c).toBeLessThanOrEqual(total);
  });
  it("sem acumulado informado mantém o comportamento antigo", () => {
    expect(releasedCommission(2_000, 8_000, 1_000)).toBe(250);
  });
});

describe("M-A08-02: arredondamento em centavos", () => {
  it("metade para cima em centavos inteiros, sem o ruído de float", () => {
    expect(toCents(1.005)).toBe(101); // 1.005 * 100 = 100.49999999999999 em float
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(roundMoney(1000.01 * 0.1)).toBe(100);
    expect(roundMoney(1000.01 * 0.15)).toBe(150);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(0)).toBe(0);
  });
  it("proporção da entrada nunca passa do total devido, com centavos exatos", () => {
    const total = roundMoney(1000.01 * 0.1);
    const parts = [333.33, 333.33, 333.34].map(amount => releasedCommission(amount, 1000, total, 0));
    parts.forEach(v => expect(toCents(v) / 100).toBe(v));
  });
});
