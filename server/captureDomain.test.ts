import { describe, expect, it } from "vitest";
import { getCaptureAppointmentPlan, getCaptureReadiness } from "./captureDomain";

describe("getCaptureReadiness", () => {
  it("sinaliza o que falta antes de mandar a captação para qualificação", () => {
    const result = getCaptureReadiness({ customerName: "Rafael", phone: "11999999999", qualificationStatus: "pending" });
    expect(result.percent).toBe(25);
    expect(result.missing).toContain("Renda familiar");
    expect(result.missing).toContain("Qualificação");
  });

  it("reconhece ficha pronta quando as informações de operação e viagem existem", () => {
    const result = getCaptureReadiness({ customerName: "Rafael", phone: "11999999999", city: "Americana", promoterId: 12, captureLocation: "Estacionamento", averageIncome: 15000, travelWeeksPerYear: 2, qualificationStatus: "qualified" });
    expect(result.percent).toBe(100);
    expect(result.missing).toEqual([]);
  });

  it("cria plano de agenda apenas quando a captação tem data e hora", () => {
    expect(getCaptureAppointmentPlan({ customerName: "Rafael" }).presentationStatus).toBe("captured");
    const scheduledAt = new Date("2026-08-21T13:00:00.000Z");
    const plan = getCaptureAppointmentPlan({ customerName: "Rafael", scheduledAt, salesRoom: "Thermas São Pedro" });
    expect(plan.presentationStatus).toBe("scheduled");
    expect(plan.task?.title).toContain("Rafael");
    expect(plan.task?.description).toContain("Thermas São Pedro");
  });
});
