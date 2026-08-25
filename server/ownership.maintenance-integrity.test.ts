import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { unitMaintenanceBlocks, units } from "../drizzle/schema";
import { ownershipRouter } from "./routers/ownership";

function query(rows: unknown[]) {
  const chain = {
    where: vi.fn(),
    limit: vi.fn(),
    for: vi.fn(async () => rows),
    then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  chain.where.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

function makeDb(unitRows: unknown[], conflicts: unknown[]) {
  const inserted: unknown[] = [];
  const tx = {
    select: vi.fn(() => ({ from: (table: unknown) => table === units ? query(unitRows) : query(conflicts) })),
    insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { inserted.push(value); return { $returningId: async () => [{ id: 901 }] }; }) })),
  };
  const db = { transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
  return { db, inserted };
}

describe("integridade de bloqueio de manutenção", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita unidade inexistente sem inserir nem auditar", async () => {
    const fixture = makeDb([], []);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = ownershipRouter.createCaller({ user: { id: 72, role: "service" } } as never);

    await expect(caller.createMaintenanceBlock({ unitId: 51, startsAt: "2026-10-10", endsAt: "2026-10-12", reason: "Manutenção preventiva" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita período invertido antes de consultar o banco", async () => {
    const caller = ownershipRouter.createCaller({ user: { id: 72, role: "service" } } as never);

    await expect(caller.createMaintenanceBlock({ unitId: 51, startsAt: "2026-10-12", endsAt: "2026-10-10", reason: "Manutenção preventiva" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMocks.getDb).not.toHaveBeenCalled();
  });

  it("rejeita conflito ativo sem inserir nem auditar", async () => {
    const fixture = makeDb([{ id: 51 }], [{ id: 700, status: "planned" }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = ownershipRouter.createCaller({ user: { id: 72, role: "service" } } as never);

    await expect(caller.createMaintenanceBlock({ unitId: 51, startsAt: "2026-10-10", endsAt: "2026-10-12", reason: "Manutenção preventiva" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("cria e audita bloqueio válido", async () => {
    const fixture = makeDb([{ id: 51 }], []);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = ownershipRouter.createCaller({ user: { id: 72, role: "service" } } as never);

    await expect(caller.createMaintenanceBlock({ unitId: 51, startsAt: "2026-10-10", endsAt: "2026-10-12", reason: "Manutenção preventiva" })).resolves.toEqual({ id: 901 });
    expect(fixture.inserted[0]).toMatchObject({ unitId: 51, reason: "Manutenção preventiva" });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(72, "unit_maintenance_block", 901, "created", expect.stringContaining("Manutenção preventiva"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "unit.maintenance.blocked", aggregateId: 901 }));
  });
});

void unitMaintenanceBlocks;

