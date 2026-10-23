import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const checklist = readFileSync(join(__dirname, "..", "client/src/components/crm/ProjectReadinessChecklist.tsx"), "utf8");
const page = readFileSync(join(__dirname, "..", "client/src/pages/ProjectSettings.tsx"), "utf8");

describe("F1.12: checklist na tela de regras do empreendimento", () => {
  it("está montado na tela, lê o checklist do servidor e relê depois de salvar", () => {
    expect(page).toMatch(/<ProjectReadinessChecklist resortId=\{resortId \? Number\(resortId\) : null\} \/>/);
    expect(page).toMatch(/projectSettings\.readiness\.invalidate\(\)/);
    expect(checklist).toMatch(/projectSettings\.readiness\.useQuery/);
  });
  it("item bloqueante em aberto aparece como bloqueio", () => {
    expect(checklist).toMatch(/Não está pronto para o 1º dia/);
    expect(checklist).toMatch(/check\.severity === "blocking" && !check\.ok \? " · bloqueia"/);
  });
});
