import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Sem infraestrutura de teste de componente: contrato de código da UI (CRM-A11). O comportamento real está em renegotiation.mysql.test.ts e no E2E de navegador.
const panel = readFileSync(join(__dirname, "..", "client/src/components/RenegotiationsPanel.tsx"), "utf8");
const page = readFileSync(join(__dirname, "..", "client/src/pages/Finance.tsx"), "utf8");

describe("RenegotiationsPanel", () => {
  it("lista os acordos e oferece aprovar, aplicar e cancelar", () => {
    expect(panel).toMatch(/listRenegotiations\.useQuery/);
    for (const mutation of ["approveRenegotiation", "applyRenegotiation", "cancelRenegotiation"]) expect(panel).toContain(`${mutation}.useMutation`);
    expect(panel).toMatch(/>Aprovar</); expect(panel).toMatch(/>Aplicar</); expect(panel).toMatch(/>Cancelar</);
  });
  it("quem propôs não aprova: o botão respeita canApprove do servidor", () => {
    expect(panel).toMatch(/disabled=\{busy \|\| !row\.canApprove\}/);
  });
  it("aplicar só aparece para acordo aprovado e está montada na tela Financeiro", () => {
    expect(panel).toMatch(/row\.status === "approved" \? <Button[\s\S]{0,120}>Aplicar</);
    expect(page).toMatch(/<RenegotiationsPanel \/>/);
  });
});
