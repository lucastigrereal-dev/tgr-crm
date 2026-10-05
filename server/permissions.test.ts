import { describe, expect, it } from "vitest";
import { canAccess, canCapability } from "./permissions";

describe("permissionMatrix", () => {
  it("keeps financial and import actions behind the correct doors", () => {
    expect(canAccess("finance", "finance")).toBe(true);
    expect(canAccess("seller", "finance")).toBe(false);
    expect(canAccess("admin", "imports")).toBe(true);
    expect(canAccess("service", "imports")).toBe(false);
  });

  it("allows finance to reconcile and pay, but not approve discounts", () => {
    expect(canCapability("finance", "finance.payment.reconcile")).toBe(true);
    expect(canCapability("finance", "commission.pay")).toBe(true);
    expect(canCapability("finance", "sales.discount.approve")).toBe(false);
  });

  it("keeps sellers out of money movement and cancellation execution", () => {
    expect(canCapability("seller", "sales.proposal.create")).toBe(true);
    expect(canCapability("seller", "finance.installment.settle")).toBe(false);
    expect(canCapability("seller", "finance.transfer.pay")).toBe(false);
    expect(canCapability("seller", "contract.cancel.execute")).toBe(false);
  });

  it("separates asking for a distrato from deciding/executing it (ADR-002)", () => {
    for (const role of ["admin", "seller", "finance", "service"] as const) expect(canCapability(role, "contract.cancel.request")).toBe(true);
    for (const role of ["seller", "finance", "service"] as const) {
      expect(canCapability(role, "contract.cancel.decide")).toBe(false);
      expect(canCapability(role, "contract.cancel.execute")).toBe(false);
    }
    expect(canCapability("admin", "contract.cancel.decide")).toBe(true);
    expect(canCapability("admin", "contract.cancel.execute")).toBe(true);
  });
});
