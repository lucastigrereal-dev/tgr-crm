import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Ficha do captador v2 na tela de Captação: teste de fonte, no padrão dos demais *.ui.test. Tudo atrás de captures.visitRule.fichaV2 (CAPTURE_FICHA_V2_ENABLED).
const page = readFileSync(path.resolve(import.meta.dirname, "../client/src/pages/Capture.tsx"), "utf8");
const fields = readFileSync(path.resolve(import.meta.dirname, "../client/src/components/crm/FichaV2Fields.tsx"), "utf8");

describe("Captação: ficha v2", () => {
  it("só aparece e só envia campo novo com a flag do servidor ligada", () => {
    expect(page).toContain("const fichaV2 = visitRule.data?.fichaV2 === true");
    expect(page).toContain("{fichaV2 ? <FichaV2Fields");
    expect(page).toContain("...(fichaV2 ? { visitMode: form.visitMode || undefined, holderAge: nullableNumber(form.holderAge), partnerPhone: form.partnerPhone || undefined } : {})");
    expect(page).toContain("applyGuestpassFields(current, fields, blank(), fichaV2)");
  });
  it("tour direto não manda horário nem passante; agendamento exige data e hora; a regra da visita aceita tour direto", () => {
    expect(page).toContain('scheduledAt: form.scheduledAt && !(fichaV2 && form.visitMode === "tour_direto") ? new Date(form.scheduledAt).toISOString() : undefined');
    expect(page).toContain('value === "tour_direto" ? { scheduledAt: "", isPasserby: false }');
    expect(page).toContain('fichaV2 && form.visitMode === "agendamento" && !form.scheduledAt');
    expect(page).toContain('!(fichaV2 && form.visitMode === "tour_direto")');
  });
  it("campos: tipo de visita, idade do titular (0–120) e 2º telefone do cônjuge", () => {
    expect(fields).toContain('value="tour_direto"');
    expect(fields).toContain('value="agendamento"');
    expect(fields).toContain("min={0} max={120}");
    expect(fields).toContain("2º telefone (cônjuge)");
  });
  it("a ficha pendente no aparelho recarrega os campos novos como texto", () => {
    expect(page).toContain("visitMode: String(source.visitMode ?? \"\")");
    expect(page).toContain("holderAge: source.holderAge == null");
  });
});
