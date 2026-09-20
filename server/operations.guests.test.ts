import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { operationsRouter } from "./routers/operations";

function makeDb(selectResponses: unknown[][] = [], updateAffectedRows?: number) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];
  const select = vi.fn(() => {
    const result = Promise.resolve(selectResponses.shift() ?? []);
    const limitChain = { for: vi.fn(async () => result), then: result.then.bind(result) };
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.limit = () => limitChain;
    chain.then = result.then.bind(result);
    return chain;
  });
  const insert = vi.fn(() => ({ values: vi.fn((value: unknown) => { inserts.push(value); return { $returningId: async () => [{ id: 722 }] }; }) }));
  const db = {
    select,
    transaction: vi.fn(async (callback: (transaction: { select: typeof select; insert: typeof insert }) => Promise<unknown>) => callback({ select, insert })),
    update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); return updateAffectedRows === undefined ? undefined : { affectedRows: updateAffectedRows }; }) })) })),
    insert,
  };
  return { db, updates, inserts };
}

describe("operação de fila e acompanhantes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("oferta vaga na fila com vencimento operacional de 24 horas e auditoria", async () => {
    const fixture = makeDb([[{ status: "waiting" }]]); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    await expect(caller.updateWaitlistStatus({ id: 55, status: "offered" })).resolves.toEqual({ success: true });
    expect(fixture.updates[0]).toMatchObject({ status: "offered", offeredAt: expect.any(Date), expiresAt: expect.any(Date) });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(9, "reservation_waitlist", 55, "status_updated", expect.stringContaining("offered"));
  });

  it("não audita uma mudança de fila que perdeu a corrida", async () => {
    const fixture = makeDb([[{ status: "waiting" }]], 0); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    await expect(caller.updateWaitlistStatus({ id: 55, status: "offered" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.updates).toHaveLength(1);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("registra acompanhante com dados estruturados e trilha de auditoria", async () => {
    const fixture = makeDb([[{ id: 44, capacity: 4, adults: 1, children: 0, status: "confirmed" }], []]); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    await expect(caller.addReservationGuest({ reservationId: 44, fullName: "Maria Tigre", documentNumber: "12345678900", relationship: "Cônjuge", birthDate: "1990-04-10" })).resolves.toEqual({ id: 722 });
    expect(fixture.inserts[0]).toMatchObject({ reservationId: 44, fullName: "Maria Tigre", documentNumber: "12345678900", relationship: "Cônjuge", birthDate: expect.any(Date) });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(9, "reservation_guest", 722, "created", expect.stringContaining("Maria Tigre"));
  });

  it("bloqueia novo acompanhante quando a contagem já atingiu a capacidade", async () => {
    const fixture = makeDb([[{ id: 44, capacity: 4, adults: 1, children: 0, status: "confirmed" }], [{ count: "3" }]]); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    await expect(caller.addReservationGuest({ reservationId: 44, fullName: "João Tigre" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.inserts).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("bloqueia acompanhante em reserva concluída ou cancelada", async () => {
    for (const status of ["completed", "cancelled"] as const) {
      const fixture = makeDb([[{ id: 44, capacity: 4, adults: 1, children: 0, status }]]);
      dbMocks.getDb.mockResolvedValue(fixture.db);
      const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

      await expect(caller.addReservationGuest({ reservationId: 44, fullName: "João Tigre" })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(fixture.inserts).toEqual([]);
      expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    }
  });

  it("bloqueia presença fora de uma hospedagem ativa", async () => {
    const fixture = makeDb([[{ checkedInAt: null, checkedOutAt: null, reservationStatus: "confirmed" }]]); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    await expect(caller.updateGuestPresence({ id: 722, action: "check_in" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.updates).toEqual([]);
  });

  it("marca presença individual do acompanhante na chegada", async () => {
    const fixture = makeDb([[{ checkedInAt: null, checkedOutAt: null, reservationStatus: "checked_in" }]]); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    await expect(caller.updateGuestPresence({ id: 722, action: "check_in" })).resolves.toEqual({ success: true, alreadyCheckedIn: false });
    expect(fixture.updates[0]).toMatchObject({ checkedInAt: expect.any(Date) });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(9, "reservation_guest", 722, "check_in", expect.stringContaining("check_in"));
  });

  it("não audita check-in que perdeu a corrida", async () => {
    const fixture = makeDb([[{ checkedInAt: null, checkedOutAt: null, reservationStatus: "checked_in" }]], 0); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    await expect(caller.updateGuestPresence({ id: 722, action: "check_in" })).resolves.toEqual({ success: true, alreadyCheckedIn: true });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});
