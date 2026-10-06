import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canCapability } from "./permissions";

// WP8 (S77, ADR-002): a tela do contrato decide o que mostrar pela MESMA matriz que o servidor aplica.
const page = readFileSync(path.join(__dirname, "../client/src/pages/ContractDetail.tsx"), "utf8");

describe("contract cancellation UI follows the capability matrix", () => {
  it("uses canCapability for request, decide and execute (no hardcoded role check)", () => {
    for (const capability of ["contract.cancel.request", "contract.cancel.decide", "contract.cancel.execute"]) {
      expect(page).toContain(`canCapability(user.role, "${capability}")`);
    }
    expect(page).not.toMatch(/canDecide=\{user\?\.role === "admin"\}/);
    expect(page).toContain("Pedir distrato");
  });

  it("finance and service can ask for a cancellation but never decide or execute it", () => {
    for (const role of ["finance", "service", "seller"] as const) {
      expect(canCapability(role, "contract.cancel.request")).toBe(true);
      expect(canCapability(role, "contract.cancel.decide")).toBe(false);
      expect(canCapability(role, "contract.cancel.execute")).toBe(false);
    }
    expect(canCapability("user", "contract.cancel.request")).toBe(false);
    expect(canCapability("admin", "contract.cancel.execute")).toBe(true);
  });
});
