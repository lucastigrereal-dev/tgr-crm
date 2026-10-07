import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { menuPathRoles } from "./permissions";

// Roteiro humano 1.3: seller/service não veem "Políticas" no menu e, se abrirem a rota, a tela mostra a recusa do servidor.
const layout = readFileSync(path.join(__dirname, "../client/src/components/DashboardLayout.tsx"), "utf8");
const page = readFileSync(path.join(__dirname, "../client/src/pages/PolicyRegistry.tsx"), "utf8");

describe("policy registry menu and refusal", () => {
  it("shows the Políticas menu item only to admin and finance (same as financeProcedure)", () => {
    // KAN-31: o menu inteiro segue a matriz única (menuPathRoles); Políticas continua só admin e finance.
    expect(layout).toContain("canOpenMenuPath(user?.role, item.path)");
    expect([...menuPathRoles["/politicas"]].sort()).toEqual(["admin", "finance"]);
  });
  it("renders the server refusal instead of an empty table", () => {
    expect(page).toContain('list.error.data?.code === "FORBIDDEN"');
    expect(page).toContain("Seu perfil não tem acesso ao registro de políticas.");
  });
});
