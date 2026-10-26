import { afterEach, describe, expect, it } from "vitest";
import { fichaV2Violation, usesFichaV2 } from "./captureFichaV2";
import { visitRuleViolation } from "./captureVisitRule";

// Ficha do captador v2 (26/10): regras puras, sem banco.
describe("ficha do captador v2: regras", () => {
  afterEach(() => { delete process.env.CAPTURE_FICHA_V2_ENABLED; });

  it("sem nenhum campo novo não muda nada, com a flag ligada ou não", () => {
    expect(usesFichaV2({ scheduledAt: "2026-11-01T14:00:00.000Z" })).toBe(false);
    expect(fichaV2Violation({})).toBeNull();
    process.env.CAPTURE_FICHA_V2_ENABLED = "true";
    expect(fichaV2Violation({})).toBeNull();
  });

  it("flag desligada (padrão): qualquer campo novo é recusado, nada é descartado em silêncio", () => {
    for (const input of [{ visitMode: "tour_direto" as const }, { holderAge: 40 }, { partnerPhone: "84999990000" }]) {
      expect(fichaV2Violation(input)).toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    expect(fichaV2Violation({ holderAge: 0 })).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fichaV2Violation({ partnerPhone: "   " })).toBeNull();
  });

  it("flag ligada: tour direto não tem horário nem é passante; agendamento exige data e horário", () => {
    process.env.CAPTURE_FICHA_V2_ENABLED = "true";
    expect(fichaV2Violation({ visitMode: "tour_direto" })).toBeNull();
    expect(fichaV2Violation({ visitMode: "tour_direto", scheduledAt: "2026-11-01T14:00:00.000Z" })).toMatchObject({ code: "BAD_REQUEST" });
    expect(fichaV2Violation({ visitMode: "tour_direto", isPasserby: true })).toMatchObject({ code: "BAD_REQUEST" });
    expect(fichaV2Violation({ visitMode: "agendamento" })).toMatchObject({ code: "BAD_REQUEST" });
    expect(fichaV2Violation({ visitMode: "agendamento", scheduledAt: "2026-11-01T14:00:00.000Z", holderAge: 41, partnerPhone: "84999990000" })).toBeNull();
  });

  it("regra da visita: tour direto vale como visita explícita; ficha sem data e sem modo segue recusada", () => {
    expect(visitRuleViolation({ visitMode: "tour_direto" })).toBeNull();
    expect(visitRuleViolation({ scheduledAt: null, isPasserby: false })).not.toBeNull();
    expect(visitRuleViolation({ visitMode: "agendamento" })).not.toBeNull();
  });
});
