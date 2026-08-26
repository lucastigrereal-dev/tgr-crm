import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function makeDb(rows: unknown[]) {
  const limitCalls: number[] = [];
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async (value: number) => {
      limitCalls.push(value);
      return rows;
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain), limitCalls };
}

describe("integridade dos candidatos de carteira financeira", () => {
  beforeEach(() => vi.clearAllMocks());

  it("expõe truncamento quando há mais de quinhentos responsáveis elegíveis", async () => {
    const rows = Array.from({ length: 501 }, (_, id) => ({ id, name: `Financeiro ${id}`, email: null, role: "finance" }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 1, role: "finance" } } as never);

    const result = await caller.portfolioCandidates();

    expect(result.rows).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["responsáveis financeiros"]);
    expect(db.limitCalls).toEqual([501]);
  });
});

export {};
