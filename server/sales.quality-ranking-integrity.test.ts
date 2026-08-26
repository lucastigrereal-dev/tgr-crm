import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function makeDb(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    leftJoin: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async () => rows),
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain) };
}

describe("integridade do ranking de qualidade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca o ranking quando a fonte de oportunidades supera o limite", async () => {
    const rows = Array.from({ length: 1001 }, (_, id) => ({
      sellerId: 7,
      sellerName: "Vendedor",
      stage: id % 2 === 0 ? "won" : "proposal",
      expectedAmount: "1000.00",
      nextFollowUpAt: null,
    }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    const result = await caller.qualityRanking();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ sellerId: 7, wonCount: 500, openCount: 500 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["oportunidades do ranking"]);
    expect(db.select.mock.results[0]?.value.limit).toHaveBeenCalledWith(1001);
  });
});

export {};

