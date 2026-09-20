import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { campaignsRouter } from "./routers/campaigns";

function makeDb(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async (value: number) => {
      expect(value).toBe(501);
      return rows;
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain) };
}

describe("integridade da lista de campanhas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("limita campanhas ativas e informa o recorte", async () => {
    const rows = Array.from({ length: 501 }, (_, id) => ({ id, code: `CMP-${id}`, name: `Campanha ${id}`, status: "active" }));
    dbMocks.getDb.mockResolvedValue(makeDb(rows));
    const caller = campaignsRouter.createCaller({ user: { id: 8, role: "seller" } } as never);

    const result = await caller.list();
    expect(result.rows).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["campanhas ativas"]);
  });
});

export {};
