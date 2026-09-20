import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { teamRouter } from "./routers/team";

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

describe("integridade da lista de equipe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("expõe truncamento quando a equipe supera quinhentos usuários", async () => {
    const rows = Array.from({ length: 501 }, (_, id) => ({ id, name: `Pessoa ${id}`, email: null, role: "seller", lastSignedIn: null, createdAt: new Date() }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = teamRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    const result = await caller.list();

    expect(result.rows).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["equipe"]);
    expect(db.limitCalls).toEqual([501]);
  });
});

export {};
