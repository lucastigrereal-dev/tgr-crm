import { describe, expect, it } from "vitest";
import { canAccess } from "./permissions";

describe("permissionMatrix", () => {
  it("keeps financial and import actions behind the correct doors", () => {
    expect(canAccess("finance", "finance")).toBe(true);
    expect(canAccess("seller", "finance")).toBe(false);
    expect(canAccess("admin", "imports")).toBe(true);
    expect(canAccess("service", "imports")).toBe(false);
  });
});
