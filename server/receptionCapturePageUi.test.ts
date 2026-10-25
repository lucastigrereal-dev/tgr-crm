import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Decisão 25/10 (2B): a tela de Captação da recepção é só de registro. Teste de fonte, no padrão dos demais *.ui.test.
const page = readFileSync(path.resolve(import.meta.dirname, "../client/src/pages/Capture.tsx"), "utf8");
const layout = readFileSync(path.resolve(import.meta.dirname, "../client/src/components/DashboardLayout.tsx"), "utf8");

describe("Captação para a recepção (papel service)", () => {
  it("não chama captures.list (exclusivo da sala) e não mostra contadores nem fila", () => {
    expect(page).toContain('const isReception = user?.role === "service"');
    expect(page).toMatch(/captures\.list\.useQuery\([^)]*\{ enabled: !isReception \}\)/);
    expect(page).toContain("{!isReception && <>");
    expect(page).toContain("{!isReception && <Card");
  });
  it("não envia captador, campanha, qualificação nem oportunidade, e esconde esses campos", () => {
    expect(page).toContain("campaignId: isReception ? null");
    expect(page).toContain("promoterId: isReception ? null");
    expect(page).toContain('qualificationStatus: isReception ? "pending"');
    expect(page).toContain("createOpportunity: false");
    for (const label of ["Campanha", "Captador", "Qualificação"]) expect(page).toContain(`{!isReception && <div className="grid gap-2"><Label>${label}</Label>`);
  });
  it("o menu só abre a Captação para a recepção com a flag do servidor", () => {
    expect(layout).toContain("captureRule.data?.receptionCreate === true");
    expect(layout).toContain("canOpenMenuPath(user?.role, item.path) || receptionOpens(item.path)");
  });
});
