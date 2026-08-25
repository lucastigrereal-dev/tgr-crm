import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { operationsRouter } from "./routers/operations";

function makeDb(selectResponses: unknown[][] = []) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];
  const db = {
    select: vi.fn(() => {
      const result = Promise.resolve(selectResponses.shift() ?? []);
      const chain: Record<string, () => unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => chain;
      chain.limit = () => result;
      return chain;
    }),
    update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); }) })) })),
    insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { inserts.push(value); return { $returningId: async () => [{ id: 722 }] }; }) })),
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

  it("registra acompanhante com dados estruturados e trilha de auditoria", async () => {
    const fixture = makeDb([[{ id: 44, capacity: 4 }], []]); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    await expect(caller.addReservationGuest({ reservationId: 44, fullName: "Maria Tigre", documentNumber: "12345678900", relationship: "Cônjuge", birthDate: "1990-04-10" })).resolves.toEqual({ id: 722 });
    expect(fixture.inserts[0]).toMatchObject({ reservationId: 44, fullName: "Maria Tigre", documentNumber: "12345678900", relationship: "Cônjuge", birthDate: expect.any(Date) });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(9, "reservation_guest", 722, "created", expect.stringContaining("Maria Tigre"));
  });

  it("marca presença individual do acompanhante na chegada", async () => {
    const fixture = makeDb([[{ checkedInAt: null, checkedOutAt: null }]]); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    await expect(caller.updateGuestPresence({ id: 722, action: "check_in" })).resolves.toEqual({ success: true, alreadyCheckedIn: false });
    expect(fixture.updates[0]).toMatchObject({ checkedInAt: expect.any(Date) });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(9, "reservation_guest", 722, "check_in", expect.stringContaining("check_in"));
  });
});
