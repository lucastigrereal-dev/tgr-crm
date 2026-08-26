import { beforeEach, describe, expect, it, vi } from "vitest";
import { contracts, customers, ownershipEntitlements, reservationWaitlist, reservations, resorts, unitMaintenanceBlocks, units } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { operationsRouter } from "./routers/operations";

function makeDb(options: { entitlementPriority?: number; maintenance?: boolean; customerMissing?: boolean; contractMissing?: boolean; contractStatus?: "draft" | "pending_signature" | "active" | "overdue" | "cancelled" | "closed"; resortMissing?: boolean; waitlistDuplicate?: boolean; waitlistInsertDuplicate?: boolean } = {}, updateAffectedRows?: number) {
  const inserted: unknown[] = [];
  const updates: unknown[] = [];
  let unitSelectCall = 0;
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      if (table === customers) return { where: () => ({ limit: async () => options.customerMissing ? [] : [{ id: 3 }] }) };
      if (table === contracts) return { where: () => ({ limit: async () => options.contractMissing ? [] : [{ id: 8, customerId: 3, status: options.contractStatus ?? "active" }] }) };
      if (table === resorts) return { where: () => ({ limit: async () => options.resortMissing ? [] : [{ id: 5 }] }) };
      if (table === ownershipEntitlements) return { where: () => ({ limit: async () => options.entitlementPriority ? [{ priorityLevel: options.entitlementPriority, status: "active" }] : [] }) };
      if (table === reservationWaitlist) return { where: () => ({ limit: async () => options.waitlistDuplicate ? [{ id: 700 }] : [] }) };
      if (table === units) return { where: () => ({ limit: () => { const rows = unitSelectCall++ === 0 ? [{ id: 18, resortId: 5, status: "active" }] : []; return { for: async () => rows, then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject) }; } }) };
      if (table === reservations) return { where: () => ({ limit: async () => [] }) };
      if (table === unitMaintenanceBlocks) return { where: () => ({ limit: async () => options.maintenance ? [{ id: 700 }] : [] }) };
      throw new Error("Tabela não prevista neste teste");
    },
  }));
  const insert = vi.fn(() => ({ values: vi.fn((value: unknown) => { inserted.push(value); return { $returningId: async () => { if (options.waitlistInsertDuplicate) throw { code: "ER_DUP_ENTRY", errno: 1062 }; return [{ id: 501 }]; } }; }) }));
  const update = vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); return updateAffectedRows === undefined ? undefined : { affectedRows: updateAffectedRows }; }) })) }));
  const transaction = vi.fn(async (callback: (tx: { select: typeof select; insert: typeof insert; update: typeof update }) => Promise<unknown>) => callback({ select, insert, update }));
  const db = { select, insert, update, transaction };
  return { db, inserted, updates };
}

describe("prioridade de direitos e bloqueio operacional", () => {
  beforeEach(() => vi.clearAllMocks());

  it("eleva a prioridade da fila com base no direito ativo do contrato", async () => {
    const fixture = makeDb({ entitlementPriority: 2 });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.joinWaitlist({ customerId: 3, contractId: 8, desiredCheckIn: "2026-11-10", desiredCheckOut: "2026-11-14", priorityScore: 15 })).resolves.toEqual({ id: 501, priorityScore: 90, entitlementScore: 90 });
    expect(fixture.inserted[0]).toMatchObject({ contractId: 8, priorityScore: 90 });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(12, "reservation_waitlist", 501, "created", expect.stringContaining("90"));
  });

  it("bloqueia duplicata ativa na fila de espera", async () => {
    const fixture = makeDb({ waitlistDuplicate: true });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.joinWaitlist({ customerId: 3, desiredCheckIn: "2026-11-10", desiredCheckOut: "2026-11-14" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("normaliza corrida da unique key da fila como conflito", async () => {
    const fixture = makeDb({ waitlistInsertDuplicate: true });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.joinWaitlist({ customerId: 3, desiredCheckIn: "2026-11-10", desiredCheckOut: "2026-11-14" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("bloqueia referências órfãs na fila de espera", async () => {
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);
    const missingCustomer = makeDb({ customerMissing: true });
    dbMocks.getDb.mockResolvedValue(missingCustomer.db);
    await expect(caller.joinWaitlist({ customerId: 3, desiredCheckIn: "2026-11-10", desiredCheckOut: "2026-11-14" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(missingCustomer.inserted).toEqual([]);

    const missingContract = makeDb({ contractMissing: true });
    dbMocks.getDb.mockResolvedValue(missingContract.db);
    await expect(caller.joinWaitlist({ customerId: 3, contractId: 8, desiredCheckIn: "2026-11-10", desiredCheckOut: "2026-11-14" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(missingContract.inserted).toEqual([]);

    const missingResort = makeDb({ resortMissing: true });
    dbMocks.getDb.mockResolvedValue(missingResort.db);
    await expect(caller.joinWaitlist({ customerId: 3, resortId: 5, desiredCheckIn: "2026-11-10", desiredCheckOut: "2026-11-14" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(missingResort.inserted).toEqual([]);
  });

  it("bloqueia reserva direta com cliente inexistente", async () => {
    const fixture = makeDb({ customerMissing: true });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.createReservation({ customerId: 999, unitId: 18, checkIn: "2026-11-10", checkOut: "2026-11-14", status: "confirmed" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
  });

  it("bloqueia reserva vinculada a contrato cancelado ou encerrado", async () => {
    for (const contractStatus of ["cancelled", "closed"] as const) {
      const fixture = makeDb({ contractStatus });
      dbMocks.getDb.mockResolvedValue(fixture.db);
      const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

      await expect(caller.createReservation({ customerId: 3, contractId: 8, unitId: 18, checkIn: "2026-11-10", checkOut: "2026-11-14", status: "confirmed" })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(fixture.inserted).toEqual([]);
    }
  });

  it("impede reserva direta em unidade bloqueada para manutenção", async () => {
    const fixture = makeDb({ maintenance: true });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.createReservation({ customerId: 3, unitId: 18, checkIn: "2026-11-10", checkOut: "2026-11-14", status: "confirmed" })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("manutenção") });
    expect(fixture.inserted).toEqual([]);
  });

  it("não audita atualização de unidade que perdeu a corrida", async () => {
    const fixture = makeDb({}, 0);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    await expect(caller.updateUnit({ id: 18, code: "1803", category: "Premium", capacity: 4, beds: 2, status: "maintenance" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.updates).toHaveLength(1);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("atualiza o status operacional da unidade e cria trilha de auditoria", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    await expect(caller.updateUnit({ id: 18, code: "1803", category: "Premium", capacity: 4, beds: 2, status: "maintenance" })).resolves.toEqual({ success: true });
    expect(fixture.updates).toEqual([{ code: "1803", category: "Premium", capacity: 4, beds: 2, status: "maintenance" }]);
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(1, "unit", 18, "updated", expect.stringContaining("maintenance"));
  });
});
