import { describe, expect, it } from "vitest";
import { assertReceptionAction, filterReceptionQueue, tourDurationMinutes } from "./salesRoomDomain";

describe("sales room reception rules", () => {
  it("exige check-in e mesa antes do início da apresentação", () => {
    expect(() => assertReceptionAction({ presentationStatus: "scheduled" }, "start_presentation")).toThrow("check-in");
    expect(() => assertReceptionAction({ presentationStatus: "checked_in" }, "start_presentation")).toThrow("mesa");
    expect(() => assertReceptionAction({ presentationStatus: "checked_in", salesTable: "M-08" }, "start_presentation")).not.toThrow();
  });

  it("protege históricos já encerrados e evita no-tour depois do começo", () => {
    expect(() => assertReceptionAction({ presentationStatus: "no_tour" }, "assign_table")).toThrow("encerrada");
    expect(() => assertReceptionAction({ presentationStatus: "presented", presentationStartedAt: new Date() }, "mark_no_tour")).toThrow("já iniciada");
  });

  it("só encerra uma apresentação realmente em curso e calcula duração positiva", () => {
    const startedAt = new Date("2026-08-20T15:00:00.000Z");
    expect(() => assertReceptionAction({ presentationStatus: "presented", presentationStartedAt: startedAt }, "end_presentation")).not.toThrow();
    expect(() => assertReceptionAction({ presentationStatus: "presented", presentationStartedAt: startedAt, presentationEndedAt: new Date() }, "end_presentation")).toThrow("já foi encerrada");
    expect(tourDurationMinutes(startedAt, new Date("2026-08-20T15:47:00.000Z"))).toBe(47);
    expect(tourDurationMinutes(startedAt, new Date("2026-08-20T14:59:00.000Z"))).toBe(0);
  });

  it("mantém na fila apenas a sala, o dia e os estados ativos na ordem do atendimento", () => {
    const rows = [
      { id: 1, capture: { presentationStatus: "checked_in" as const, scheduledAt: new Date("2026-08-20T16:00:00-03:00"), salesRoom: "Ouro" } },
      { id: 2, capture: { presentationStatus: "closed" as const, scheduledAt: new Date("2026-08-20T13:00:00-03:00"), salesRoom: "Ouro" } },
      { id: 3, capture: { presentationStatus: "scheduled" as const, scheduledAt: new Date("2026-08-20T14:00:00-03:00"), salesRoom: "Ouro" } },
      { id: 4, capture: { presentationStatus: "scheduled" as const, scheduledAt: new Date("2026-08-20T12:00:00-03:00"), salesRoom: "Prata" } },
      { id: 5, capture: { presentationStatus: "scheduled" as const, scheduledAt: new Date("2026-08-21T12:00:00-03:00"), salesRoom: "Ouro" } },
    ];
    expect(filterReceptionQueue(rows, { date: "2026-08-20", salesRoom: "Ouro" }).map(row => row.id)).toEqual([3, 1]);
    expect(filterReceptionQueue(rows, { date: "2026-08-20", salesRoom: "Ouro", includeCompleted: true }).map(row => row.id)).toEqual([2, 3, 1]);
  });
});
