import { beforeEach, describe, expect, it, vi } from "vitest";
import { reservationWaitlist, reservations, reservationGuests, unitMaintenanceBlocks, units } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { operationsRouter } from "./routers/operations";

function querySequence(responses: unknown[][]) {
  return vi.fn(() => {
    const result = Promise.resolve(responses.shift() ?? []);
    const chain: Record<string, () => unknown> = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.leftJoin = () => chain;
    chain.where = () => chain;
    chain.limit = () => result;
    return chain;
  });
}

describe("conversão de lista de espera e saída integrada", () => {
  beforeEach(() => vi.clearAllMocks());

  it("converte uma oferta em reserva real e encerra a posição da fila na mesma transação", async () => {
    const inserts: unknown[] = []; const updates: unknown[] = [];
    const waitlistItem = { id: 33, status: "offered", customerId: 7, contractId: null, resortId: 2, desiredCheckIn: new Date("2026-12-10T12:00:00Z"), desiredCheckOut: new Date("2026-12-14T12:00:00Z"), partySize: 3, preferenceNotes: "Andar alto" };
    const transaction = { insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { inserts.push(value); return { $returningId: async () => [{ id: 901 }] }; }) })), update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); }) })) })) };
    const db = {
      select: vi.fn(() => ({ from: (table: unknown) => {
        if (table === reservationWaitlist) return { where: () => ({ limit: async () => [waitlistItem] }) };
        if (table === units) return { where: () => ({ limit: async () => [{ id: 19, resortId: 2, status: "active" }] }) };
        if (table === reservations || table === unitMaintenanceBlocks) return { where: () => ({ limit: async () => [] }) };
        throw new Error("Consulta não prevista");
      } })),
      transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = operationsRouter.createCaller({ user: { id: 4, role: "service" } } as never);

    await expect(caller.convertWaitlistToReservation({ waitlistId: 33, unitId: 19 })).resolves.toEqual({ reservationId: 901 });
    expect(inserts[0]).toMatchObject({ customerId: 7, unitId: 19, adults: 3, status: "confirmed", notes: "Andar alto" });
    expect(updates).toEqual([{ status: "confirmed" }]);
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(4, "reservation", 901, "created_from_waitlist", expect.stringContaining("33"));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(4, "reservation_waitlist", 33, "converted_to_reservation", expect.stringContaining("901"));
  });

  it("encerra automaticamente os acompanhantes presentes quando a reserva faz checkout", async () => {
    const updates: unknown[] = [];
    const db = { select: querySequence([[{ status: "checked_in" }]]), update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); }) })) })) };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = operationsRouter.createCaller({ user: { id: 4, role: "service" } } as never);

    await expect(caller.updateReservationStatus({ id: 901, status: "completed" })).resolves.toEqual({ success: true });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ status: "completed", checkedOutAt: expect.any(Date) });
    expect(updates[1]).toMatchObject({ checkedOutAt: expect.any(Date) });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(4, "reservation", 901, "status_updated", expect.stringContaining("completed"));
  });

  it("mantém a jornada completa de chegada e saída coerente para reserva e acompanhante", async () => {
    const updates: unknown[] = [];
    const db = { select: querySequence([[{ status: "confirmed" }], [{ checkedInAt: null, checkedOutAt: null }], [{ status: "checked_in" }]]), update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); }) })) })) };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = operationsRouter.createCaller({ user: { id: 4, role: "service" } } as never);

    await caller.updateReservationStatus({ id: 901, status: "checked_in" });
    await caller.updateGuestPresence({ id: 722, action: "check_in" });
    await caller.updateReservationStatus({ id: 901, status: "completed" });

    expect(updates).toHaveLength(4);
    expect(updates[0]).toMatchObject({ status: "checked_in", checkedInAt: expect.any(Date) });
    expect(updates[1]).toMatchObject({ checkedInAt: expect.any(Date) });
    expect(updates[2]).toMatchObject({ status: "completed", checkedOutAt: expect.any(Date) });
    expect(updates[3]).toMatchObject({ checkedOutAt: expect.any(Date) });
    expect(dbMocks.recordAudit).toHaveBeenNthCalledWith(1, 4, "reservation", 901, "status_updated", expect.stringContaining("checked_in"));
    expect(dbMocks.recordAudit).toHaveBeenNthCalledWith(2, 4, "reservation_guest", 722, "check_in", expect.stringContaining("check_in"));
    expect(dbMocks.recordAudit).toHaveBeenNthCalledWith(3, 4, "reservation", 901, "status_updated", expect.stringContaining("completed"));
  });
});
