import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function makeDb(rows: unknown[]) {
  const limitCalls: number[] = [];
  const chain = {
    from: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async (value: number) => {
      limitCalls.push(value);
      return rows;
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain), limitCalls };
}

describe("integridade do catálogo financeiro de campanhas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("expõe truncamento quando há mais de duzentas campanhas", async () => {
    const rows = Array.from({ length: 201 }, (_, id) => ({ id, name: `Campanha ${id}`, code: `C-${id}`, status: "active" }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 1, role: "finance" } } as never);

    const result = await caller.campaigns();

    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["campanhas financeiras"]);
    expect(db.limitCalls).toEqual([201]);
  });
});

export {};
