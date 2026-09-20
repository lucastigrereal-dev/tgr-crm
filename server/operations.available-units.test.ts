import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { reservations, resorts, unitMaintenanceBlocks, units } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { operationsRouter } from "./routers/operations";

function makeDb(activeUnits = [{ unit: { id: 19, resortId: 2, status: "active", code: "A-19" }, resortName: "TGR Resort" }]) {
  const fromTables: unknown[] = [];
  const getSqlCalls: unknown[] = [];
  const limitCalls: number[] = [];
  const select = vi.fn(() => {
    const chain = {
      from: vi.fn((table: unknown) => {
        fromTables.push(table);
        return chain;
      }),
      where: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(async (value: number) => {
        limitCalls.push(value);
        return activeUnits;
      }),
      getSQL: vi.fn(() => {
        getSqlCalls.push(true);
        return sql`1`;
      }),
    };
    return chain;
  });
  return { select, activeUnits, fromTables, getSqlCalls, limitCalls };
}

describe("disponibilidade de unidades", () => {
  beforeEach(() => vi.clearAllMocks());

  it("monta disponibilidade no banco com conflitos correlacionados", async () => {
    const db = makeDb();
    dbMocks.getDb.mockResolvedValue(db);
    const caller = operationsRouter.createCaller({ user: { id: 4, role: "service" } } as never);

    await expect(caller.availableUnits({ checkIn: "2026-12-10", checkOut: "2026-12-14", resortId: 2 })).resolves.toEqual({ rows: db.activeUnits, truncated: false, truncatedSources: [] });

    expect(db.select).toHaveBeenCalledTimes(3);
    expect(db.fromTables).toEqual(expect.arrayContaining([reservations, unitMaintenanceBlocks, units]));
    expect(db.limitCalls).toEqual([5001]);
  });

  it("expõe truncamento quando a disponibilidade supera cinco mil unidades", async () => {
    const activeUnits = Array.from({ length: 5001 }, (_, id) => ({ unit: { id, resortId: 2, status: "active", code: `A-${id}` }, resortName: "TGR Resort" }));
    const db = makeDb(activeUnits);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = operationsRouter.createCaller({ user: { id: 4, role: "service" } } as never);

    const result = await caller.availableUnits({ checkIn: "2026-12-10", checkOut: "2026-12-14", resortId: 2 });
    expect(result.rows).toHaveLength(5000);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["unidades disponíveis"]);
    expect(db.limitCalls).toEqual([5001]);
  });
});

