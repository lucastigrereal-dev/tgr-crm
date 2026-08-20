import { describe, expect, it } from "vitest";
import { buildInstallmentSchedule, getCollectionStage, isValidReservationPeriod, resolveFollowUpAt, shouldCreatePaymentReminder } from "./domain";

describe("regras operacionais", () => {
  it("distribui parcelas preservando o valor total em centavos", () => {
    const schedule = buildInstallmentSchedule(1000, 3, "2026-09-10");
    expect(schedule).toHaveLength(3);
    expect(schedule.map(item => item.amount)).toEqual(["333.34", "333.33", "333.33"]);
    expect(schedule.reduce((sum, item) => sum + Number(item.amount), 0)).toBeCloseTo(1000, 2);
  });

  it("rejeita reservas com saída igual ou anterior ao check-in", () => {
    const checkIn = new Date("2026-09-10T12:00:00Z");
    expect(isValidReservationPeriod(checkIn, new Date("2026-09-10T12:00:00Z"))).toBe(false);
    expect(isValidReservationPeriod(checkIn, new Date("2026-09-09T12:00:00Z"))).toBe(false);
    expect(isValidReservationPeriod(checkIn, new Date("2026-09-11T12:00:00Z"))).toBe(true);
  });

  it("programa lembrete de cobrança para vencimento próximo ou atrasado", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    expect(shouldCreatePaymentReminder(new Date("2026-09-08T12:00:00Z"), now)).toBe(true);
    expect(shouldCreatePaymentReminder(new Date("2026-08-28T12:00:00Z"), now)).toBe(true);
    expect(shouldCreatePaymentReminder(new Date("2026-09-09T12:00:00Z"), now)).toBe(false);
  });

  it("classifica a régua de cobrança por proximidade e atraso", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    expect(getCollectionStage(new Date("2026-09-14T12:00:00Z"), now)).toMatchObject({ code: "pre_due", priority: "normal" });
    expect(getCollectionStage(new Date("2026-09-10T12:00:00Z"), now)).toMatchObject({ code: "due_today", priority: "high" });
    expect(getCollectionStage(new Date("2026-09-04T12:00:00Z"), now)).toMatchObject({ code: "late_soft", priority: "high" });
    expect(getCollectionStage(new Date("2026-08-20T12:00:00Z"), now)).toMatchObject({ code: "late_urgent", priority: "urgent" });
  });

  it("cria follow-up comercial em 48 horas se o vendedor não informar data", () => {
    const now = new Date("2026-09-01T10:00:00Z");
    expect(resolveFollowUpAt(undefined, now).toISOString()).toBe("2026-09-03T10:00:00.000Z");
    expect(resolveFollowUpAt("2026-09-02T13:00:00.000Z", now).toISOString()).toBe("2026-09-02T13:00:00.000Z");
  });
});
