import { expect, it } from "vitest";
import { buildProfessionalRhythmAlerts } from "./professionalRhythm";

it("sinaliza ritmo por papel sem acusar quem teve evento recente", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  const alerts = buildProfessionalRhythmAlerts({ roster: [{ userId: 1, role: "promoter" }, { userId: 2, role: "closer" }, { userId: 3, role: "room_manager" }], facts: [{ userId: 1, role: "promoter", entityId: 10, label: "Captação validada", eventAt: new Date("2026-08-20T12:00:00Z") }, { userId: 2, role: "closer", entityId: 11, label: "Proposta encaminhada", eventAt: new Date("2026-08-19T12:00:00Z") }], now });
  expect(alerts).toEqual([expect.objectContaining({ userId: 2, role: "closer", severity: "attention", daysWithoutEvent: 2 }), expect.objectContaining({ userId: 3, role: "room_manager", severity: "critical", evidence: expect.stringContaining("Nenhum evento") })]);
});
