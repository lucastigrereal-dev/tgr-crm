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

function updateRecorder(affectedRows = 1) {
  const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ affectedRows }) }));
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

  it("não audita check-in que perdeu a corrida", async () => {
    const recorder = updateRecorder(0);
    mockedDb.mockResolvedValue({ select: vi.fn(() => chain([capture()])), ...recorder } as never);

    await expect(caller("service").captures.checkIn({ id: 91 })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(recordAudit).not.toHaveBeenCalled();
    expect(recordDomainEvent).not.toHaveBeenCalled();
  });

  it("não audita atualização de status que perdeu a corrida", async () => {
    const recorder = updateRecorder(0);
    mockedDb.mockResolvedValue({ select: vi.fn(() => chain([capture()])), ...recorder } as never);

    await expect(caller("admin").captures.updateStatus({ id: 91, presentationStatus: "checked_in" })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(recordAudit).not.toHaveBeenCalled();
    expect(recordDomainEvent).not.toHaveBeenCalled();
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

  it("filtra a fila por sala e deixa encerrados fora da operação ativa", async () => {
    const activePresented = capture({ id: 92, presentationStatus: "presented", scheduledAt: new Date("2026-08-21T10:00:00-03:00") });
    const activeScheduled = capture({ id: 91, presentationStatus: "scheduled", scheduledAt: new Date("2026-08-21T11:00:00-03:00") });
    const completed = capture({ id: 93, presentationStatus: "closed", scheduledAt: new Date("2026-08-21T09:00:00-03:00") });
    const noTour = capture({ id: 94, presentationStatus: "no_tour", scheduledAt: new Date("2026-08-21T08:00:00-03:00") });
    const otherRoom = capture({ id: 95, salesRoom: "Sala Prata", presentationStatus: "scheduled", scheduledAt: new Date("2026-08-21T07:00:00-03:00") });
    const otherDate = capture({ id: 96, presentationStatus: "scheduled", scheduledAt: new Date("2026-08-22T07:00:00-03:00") });
    mockedDb.mockResolvedValue({ select: vi.fn(() => chain([
      { capture: activeScheduled, customer: { name: "Bia" }, campaign: null },
      { capture: completed, customer: { name: "Caio" }, campaign: null },
      { capture: activePresented, customer: { name: "Ana" }, campaign: null },
      { capture: noTour, customer: { name: "Dani" }, campaign: null },
      { capture: otherRoom, customer: { name: "Eva" }, campaign: null },
      { capture: otherDate, customer: { name: "Fábio" }, campaign: null },
    ])) } as never);

    const activeQueue = await caller("service").captures.receptionQueue({ date: "2026-08-21", salesRoom: "Sala Ouro" });
    const fullQueue = await caller("service").captures.receptionQueue({ date: "2026-08-21", salesRoom: "Sala Ouro", includeCompleted: true });

    expect(activeQueue.map(row => row.capture.id)).toEqual([92, 91]);
    expect(fullQueue.map(row => row.capture.id)).toEqual([94, 93, 92, 91]);
  });

  it("percorre a jornada integrada da recepção e remove tour encerrado ou sem-tour da fila", async () => {
    const tour = capture({ id: 201, scheduledAt: new Date("2026-08-21T10:00:00-03:00") }) as Record<string, unknown>;
    const noTour = capture({ id: 202, scheduledAt: new Date("2026-08-21T11:00:00-03:00") }) as Record<string, unknown>;
    let selected: Record<string, unknown> | null = null;
    const responses = [
      () => [tour],
      () => [tour],
      () => [tour],
      () => [{ capture: tour, customer: { name: "Ana" }, campaign: null }, { capture: noTour, customer: { name: "Bia" }, campaign: null }],
      () => [tour],
      () => [noTour],
      () => [noTour],
      () => [{ capture: tour, customer: { name: "Ana" }, campaign: null }, { capture: noTour, customer: { name: "Bia" }, campaign: null }],
    ];
    const set = vi.fn((patch: Record<string, unknown>) => {
      Object.assign(selected!, patch);
      return { where: vi.fn().mockResolvedValue({ affectedRows: 1 }) };
    });
    mockedDb.mockResolvedValue({
      select: vi.fn(() => {
        const rows = responses.shift()?.() ?? [];
        if (rows[0] && !("capture" in (rows[0] as object))) selected = rows[0] as Record<string, unknown>;
        return chain(rows);
      }),
      update: vi.fn(() => ({ set })),
    } as never);

    const room = caller("service").captures;
    await room.checkIn({ id: 201, receptionNotes: "Chegou para o tour" });
    await room.assignRoom({ id: 201, salesTable: "M-03", linerId: 31, closerId: 32 });
    await room.startPresentation({ id: 201 });
    expect((await room.receptionQueue({ date: "2026-08-21", salesRoom: "Sala Ouro" })).map(row => row.capture.id)).toEqual([201, 202]);

    await room.endPresentation({ id: 201 });
    await room.checkIn({ id: 202 });
    await room.markNoTour({ id: 202, reason: "Casal desistiu antes do tour." });
    expect((await room.receptionQueue({ date: "2026-08-21", salesRoom: "Sala Ouro" })).map(row => row.capture.id)).toEqual([]);

    expect(tour).toMatchObject({ presentationStatus: "closed", salesTable: "M-03", linerId: 31, closerId: 32, presentationStartedAt: expect.any(Date), presentationEndedAt: expect.any(Date) });
    expect(noTour).toMatchObject({ presentationStatus: "no_tour", noTourReason: "Casal desistiu antes do tour.", checkedInAt: expect.any(Date), presentationEndedAt: expect.any(Date) });
    expect(recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "capture.presentation.ended", aggregateId: 201 }));
    expect(recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "capture.no_tour", aggregateId: 202 }));
  });
});
