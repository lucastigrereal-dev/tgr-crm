import { describe, expect, it } from "vitest";
import { addDays, addMonthsClamped, buildBalanceSchedule, localDateInTimezone, parseSaleTermsPolicy, splitCents } from "./saleTermsPolicy";

describe("sale terms policy", () => {
  it("splits cents exactly without losing or inventing money", () => {
    expect(splitCents(10003, 5)).toEqual([2001, 2001, 2001, 2000, 2000]);
    expect(splitCents(10003, 5).reduce((sum, value) => sum + value, 0)).toBe(10003);
  });

  it("clamps monthly due dates at the end of shorter months", () => {
    expect(addMonthsClamped("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("builds an exact monthly balance schedule after the entry", () => {
    const rows = buildBalanceSchedule({
      balanceCents: 2523,
      count: 3,
      firstDueDate: "2026-12-31",
      cadenceMonths: 1,
      sequenceOffset: 2,
    });
    expect(rows).toEqual([
      { sequence: 3, amountCents: 841, dueDate: "2026-12-31" },
      { sequence: 4, amountCents: 841, dueDate: "2027-01-31" },
      { sequence: 5, amountCents: 841, dueDate: "2027-02-28" },
    ]);
  });

  it("uses the project timezone before adding the balance grace period", () => {
    const saleAt = new Date("2026-09-26T01:30:00.000Z");
    expect(localDateInTimezone(saleAt, "America/Recife")).toBe("2026-09-25");
    expect(addDays("2026-09-25", 120)).toBe("2027-01-23");
  });

  it("rejects incomplete product terms", () => {
    expect(() => parseSaleTermsPolicy({ usageModel: "fixed_week", balanceInstallmentCount: 0 })).toThrow();
    expect(parseSaleTermsPolicy({ usageModel: "fixed_week", balanceInstallmentCount: 84 })).toMatchObject({
      usageModel: "fixed_week",
      balanceInstallmentCount: 84,
      balanceCadenceMonths: 1,
    });
  });
});
