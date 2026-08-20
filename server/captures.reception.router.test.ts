import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
import { getDb, recordAudit, recordDomainEvent } from "./db";
import { appRouter } from "./routers";

const mockedDb = vi.mocked(getDb);

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, () => unknown>;
  for (const method of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) promise[method] = () => promise;
  return promise;
}

function caller(role: string) { return appRouter.createCaller({ user: { id: 17, role } } as never); }

function capture(overrides: Record<string, unknown> = {}) {
  return {
    id: 91,
    salesRoom: "Sala Ouro",
    salesTable: null,
    linerId: null,
    closerId: null,
    receptionNotes: null,
    presentationStatus: "scheduled",
    presentationStartedAt: null,
    presentationEndedAt: null,
    ...overrides,
  };
}

function updateRecorder() {
  const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ affectedRows: 1 }) }));
  return { update: vi.fn(() => ({ set })), set };
}

describe("captures reception router", () => {
  beforeEach(() => vi.resetAllMocks());

  it("restringe ações de sala a recepção, comercial e administração", async () => {
    await expect(caller("finance").captures.checkIn({ id: 91 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mockedDb).not.toHaveBeenCalled();
  });

  it("registra chegada e emite auditoria/evento permitidos", async () => {
    const recorder = updateRecorder();
    mockedDb.mockResolvedValue({ select: vi.fn(() => chain([capture()])), ...recorder } as never);

    await caller("service").captures.checkIn({ id: 91, receptionNotes: "Casal chegou no horário" });

    expect(recorder.set).toHaveBeenCalledWith(expect.objectContaining({ presentationStatus: "checked_in", receptionNotes: "Casal chegou no horário", checkedInAt: expect.any(Date) }));
    expect(recordAudit).toHaveBeenCalledWith(17, "capture", 91, "checked_in", expect.any(String));
    expect(recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "capture.checked_in", aggregateId: 91 }));
  });

  it("atribui mesa, liner e fechador depois do check-in", async () => {
    const recorder = updateRecorder();
    mockedDb.mockResolvedValue({ select: vi.fn(() => chain([capture({ presentationStatus: "checked_in" })])), ...recorder } as never);

    await caller("seller").captures.assignRoom({ id: 91, salesTable: "M-08", linerId: 31, closerId: 32 });

    expect(recorder.set).toHaveBeenCalledWith(expect.objectContaining({ salesTable: "M-08", linerId: 31, closerId: 32, assignedAt: expect.any(Date) }));
    expect(recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "capture.room.assigned", payload: expect.objectContaining({ salesTable: "M-08" }) }));
  });

  it("só inicia tour após mesa e encerra a apresentação em estado fechado", async () => {
    const startRecorder = updateRecorder();
    mockedDb.mockResolvedValueOnce({ select: vi.fn(() => chain([capture({ presentationStatus: "checked_in", salesTable: "M-08" })])), ...startRecorder } as never);
    await caller("service").captures.startPresentation({ id: 91 });
    expect(startRecorder.set).toHaveBeenCalledWith({ presentationStatus: "presented", presentationStartedAt: expect.any(Date), presentationEndedAt: null });

    const endRecorder = updateRecorder();
    mockedDb.mockResolvedValueOnce({ select: vi.fn(() => chain([capture({ presentationStatus: "presented", salesTable: "M-08", presentationStartedAt: new Date("2026-08-20T14:00:00.000Z") })])), ...endRecorder } as never);
    await caller("service").captures.endPresentation({ id: 91 });
    expect(endRecorder.set).toHaveBeenCalledWith({ presentationStatus: "closed", presentationEndedAt: expect.any(Date) });
    expect(recordDomainEvent).toHaveBeenLastCalledWith(expect.objectContaining({ eventName: "capture.presentation.ended" }));
  });

  it("encerra sem-tour somente com motivo registrado", async () => {
    const recorder = updateRecorder();
    mockedDb.mockResolvedValue({ select: vi.fn(() => chain([capture()])), ...recorder } as never);

    await caller("service").captures.markNoTour({ id: 91, reason: "Casal desistiu antes da apresentação." });

    expect(recorder.set).toHaveBeenCalledWith(expect.objectContaining({ presentationStatus: "no_tour", noTourReason: "Casal desistiu antes da apresentação.", presentationEndedAt: expect.any(Date) }));
    expect(recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "capture.no_tour", payload: expect.objectContaining({ reason: "Casal desistiu antes da apresentação." }) }));
  });
});
