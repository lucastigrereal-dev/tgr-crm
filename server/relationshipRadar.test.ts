import { describe, expect, it } from "vitest";
import { buildRelationshipRadar } from "./relationshipRadar";

describe("radar de relacionamento", () => {
  it("expõe score, risco e checklist a partir de evidências cadastradas", () => {
    const radar = buildRelationshipRadar({ hasEmail: true, hasPhone: true, interactionDates: [new Date("2026-08-12T12:00:00Z")], documentCount: 2, contractStatuses: ["active"], reservationDates: [new Date("2026-09-15T12:00:00Z")], installmentStatuses: ["paid", "open"] }, new Date("2026-08-20T12:00:00Z"));
    expect(radar).toMatchObject({ score: 100, label: "saudável" });
    expect(radar.onboarding.every(item => item.complete)).toBe(true);
  });

  it("sinaliza falta de contato, cadência e atraso sem inventar dados", () => {
    const radar = buildRelationshipRadar({ hasEmail: false, hasPhone: false, interactionDates: [], documentCount: 0, contractStatuses: ["active"], reservationDates: [], installmentStatuses: ["overdue"] }, new Date("2026-08-20T12:00:00Z"));
    expect(radar).toMatchObject({ score: 20, label: "crítico" });
    expect(radar.signals.join(" ")).toContain("atraso");
  });
});
