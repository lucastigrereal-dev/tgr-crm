import { describe, expect, it } from "vitest";
import { buildConversionBreakdown, calculateConversionMetrics, filterConversionCaptures, type ConversionCapture } from "./salesRoomAnalytics";

const date = (value: string) => new Date(value);
const capture = (overrides: Partial<ConversionCapture>): ConversionCapture => ({ id: 1, createdAt: date("2026-08-01T12:00:00Z"), scheduledAt: date("2026-08-10T12:00:00Z"), campaignId: 1, promoterId: 10, linerId: 20, closerId: 30, presentationStatus: "scheduled", checkedInAt: null, presentationStartedAt: null, opportunityStage: "new", ...overrides });

describe("sales room conversion analytics", () => {
  it("calcula o funil sem contar sem-tour como apresentação e sem dividir por zero", () => {
    const metrics = calculateConversionMetrics([
      capture({ id: 1, checkedInAt: date("2026-08-10T12:05:00Z"), presentationStartedAt: date("2026-08-10T12:10:00Z"), presentationStatus: "closed", opportunityStage: "won" }),
      capture({ id: 2, presentationStatus: "no_tour", opportunityStage: "lost" }),
      capture({ id: 3, presentationStatus: "captured", scheduledAt: null }),
    ]);
    expect(metrics).toMatchObject({ captures: 3, scheduled: 2, arrivals: 1, presentations: 1, completed: 1, noTours: 1, wins: 1, arrivalRate: 50, tourRate: 100, closeRate: 100, noTourRate: 50 });
    expect(calculateConversionMetrics([]).closeRate).toBe(0);
  });

  it("passante (sem data marcada) não entra em agendadas: nem no denominador nem no numerador de chegada e sem-tour", () => {
    const metrics = calculateConversionMetrics([
      capture({ id: 1, checkedInAt: date("2026-08-10T12:05:00Z"), presentationStartedAt: date("2026-08-10T12:10:00Z"), presentationStatus: "closed" }),
      capture({ id: 2, presentationStatus: "scheduled" }),
      capture({ id: 3, scheduledAt: null, presentationStatus: "checked_in", checkedInAt: date("2026-08-01T13:00:00Z") }),
      capture({ id: 4, scheduledAt: null, presentationStatus: "no_tour" }),
    ]);
    expect(metrics).toMatchObject({ captures: 4, scheduled: 2, arrivals: 2, noTours: 1, arrivalRate: 50, noTourRate: 0 });
    // só passantes: nada a dividir, taxas 0 (nunca acima de 100%)
    const onlyWalkIns = calculateConversionMetrics([capture({ id: 5, scheduledAt: null, presentationStatus: "checked_in", checkedInAt: date("2026-08-01T13:00:00Z") })]);
    expect(onlyWalkIns).toMatchObject({ scheduled: 0, arrivals: 1, arrivalRate: 0, noTourRate: 0 });
  });

  it("os recortes por campanha/captador/consultor/fechador usam a mesma regra", () => {
    const rows = [capture({ id: 1, scheduledAt: null, presentationStatus: "checked_in", checkedInAt: date("2026-08-01T13:00:00Z") }), capture({ id: 2, checkedInAt: date("2026-08-10T12:05:00Z"), presentationStatus: "checked_in" })];
    for (const dimension of ["campaign", "promoter", "liner", "closer"] as const) {
      const [row] = buildConversionBreakdown({ captures: rows, dimension, names: { campaigns: new Map(), users: new Map() } });
      expect(row).toMatchObject({ captures: 2, scheduled: 1, arrivals: 2, arrivalRate: 100 });
    }
  });

  it("agrega por papel e preserva não atribuído como evidência, não como buraco escondido", () => {
    const rows = [capture({ id: 1, promoterId: 10, opportunityStage: "won", checkedInAt: date("2026-08-10T12:05:00Z"), presentationStartedAt: date("2026-08-10T12:10:00Z") }), capture({ id: 2, promoterId: null, presentationStatus: "no_tour" })];
    const result = buildConversionBreakdown({ captures: rows, dimension: "promoter", names: { campaigns: new Map(), users: new Map([[10, "Ana Promotora"]]) } });
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: 10, label: "Ana Promotora", wins: 1 }), expect.objectContaining({ id: null, label: "Não atribuído", noTours: 1 })]));
  });

  it("usa agenda quando existe e criação como fallback temporal de ficha sem agenda", () => {
    const rows = [capture({ id: 1, scheduledAt: date("2026-08-10T12:00:00Z") }), capture({ id: 2, scheduledAt: null, createdAt: date("2026-08-12T12:00:00Z") })];
    expect(filterConversionCaptures(rows, date("2026-08-10T00:00:00Z"), date("2026-08-11T00:00:00Z")).map(item => item.id)).toEqual([1]);
    expect(filterConversionCaptures(rows, date("2026-08-12T00:00:00Z"), date("2026-08-13T00:00:00Z")).map(item => item.id)).toEqual([2]);
  });
});
