import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { projectSettingsRouter } from "./routers/projectSettings";

function makeDb(rows: unknown[]) {
  const limitCalls: number[] = [];
  const orderByCalls: unknown[] = [];
  const chain = {
    from: vi.fn(),
    leftJoin: vi.fn(),
    orderBy: vi.fn((...args: unknown[]) => {
      orderByCalls.push(args);
      return chain;
    }),
    limit: vi.fn(async (value: number) => {
      limitCalls.push(value);
      return rows;
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  return { select: vi.fn(() => chain), limitCalls, orderByCalls };
}

describe("integridade da lista de configurações por empreendimento", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ordena e expõe truncamento quando há mais de mil empreendimentos", async () => {
    const rows = Array.from({ length: 1001 }, (_, id) => ({
      resort: { id, name: `Resort ${id}` },
      settings: null,
    }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = projectSettingsRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    const result = await caller.list();

    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["configurações por empreendimento"]);
    expect(db.limitCalls).toEqual([1001]);
    expect(db.orderByCalls).toHaveLength(1);
  });
});

export {};
