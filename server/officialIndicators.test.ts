import { describe, expect, it } from "vitest";
import { classifyAttendances, computeOfficialIndicators, hasOutcome, type AttendanceFact } from "./officialIndicators";

const from = new Date("2026-10-01T00:00:00Z"), to = new Date("2026-11-01T00:00:00Z");
const fact = (over: Partial<AttendanceFact> = {}): AttendanceFact => ({ checkedInAt: new Date("2026-10-10T15:00:00Z"), presentationStatus: "closed", commercialOutcome: null, ntKind: null, ...over });

describe("indicadores oficiais do CRM (D1, provisório)", () => {
  it("100 atendimentos, 20 vendas, 30 cotas => 20% de aproveitamento e 30 cotas por 100", () => {
    expect(computeOfficialIndicators({ attendances: 100, validatedSales: 20, soldQuotas: 30 })).toMatchObject({ utilizationPct: 20, efficiencyPer100: 30 });
  });
  it("sem atendimento não divide por zero", () => {
    expect(computeOfficialIndicators({ attendances: 0, validatedSales: 3, soldQuotas: 3 })).toMatchObject({ utilizationPct: 0, efficiencyPer100: 0 });
  });
  it("denominador: só check-in no período com desfecho; em andamento fica fora e é contado à parte", () => {
    const facts = [fact(), fact({ presentationStatus: "no_tour", ntKind: "perfil" }), fact({ presentationStatus: "presented", commercialOutcome: "caiu_em_mesa" }), fact({ presentationStatus: "presented" }), fact({ presentationStatus: "checked_in" }), fact({ checkedInAt: null }), fact({ checkedInAt: new Date("2026-09-30T23:59:59Z") }), fact({ checkedInAt: new Date("2026-11-01T00:00:00Z") })];
    expect(classifyAttendances(facts, from, to, false)).toEqual({ attendances: 3, inProgressExcluded: 2, inProgressTotal: 2 });
    expect(classifyAttendances(facts, from, to, true)).toEqual({ attendances: 5, inProgressExcluded: 0, inProgressTotal: 2 });
  });
  it("desfecho = resultado comercial, NT, ficha encerrada ou venda validada", () => {
    expect(hasOutcome(fact({ presentationStatus: "presented" }))).toBe(false);
    expect(hasOutcome(fact({ presentationStatus: "presented", hasValidatedSale: true }))).toBe(true);
    expect(hasOutcome(fact({ presentationStatus: "presented", commercialOutcome: "vendeu" }))).toBe(true);
  });
});
