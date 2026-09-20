import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { contractsRouter } from "./routers/contracts";

function makeDb(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async (value: number) => {
      expect(value).toBe(101);
      return rows;
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain), chain };
}

describe("integridade da lista de contratos", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca a lista quando há contratos além do limite operacional", async () => {
    const rows = Array.from({ length: 101 }, (_, id) => ({
      contract: { id, number: `CTR-${id}`, status: "active" },
      customerName: "Associado",
      sellerName: "Vendedor",
    }));
    const fixture = makeDb(rows);
    dbMocks.getDb.mockResolvedValue({ select: fixture.select });
    const caller = contractsRouter.createCaller({ user: { id: 7, role: "finance" } } as never);

    const result = await caller.list({ limit: 100, status: "active" });
    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["contratos"]);
    expect(fixture.chain.limit).toHaveBeenCalledWith(101);
  });
});

export {};
