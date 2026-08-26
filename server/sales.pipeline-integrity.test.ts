import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function makeDb(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async () => rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain), chain };
}

describe("integridade do pipeline comercial", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca a carteira quando o pipeline supera o limite operacional", async () => {
    const rows = Array.from({ length: 121 }, (_, id) => ({
      opportunity: { id, stage: "new", title: `Oportunidade ${id}` },
      customerName: "Cliente",
      sellerName: "Vendedor",
    }));
    const { select, chain } = makeDb(rows);
    dbMocks.getDb.mockResolvedValue({ select });
    const caller = salesRouter.createCaller({ user: { id: 7, role: "seller" } } as never);

    const result = await caller.pipeline({ limit: 120 });
    expect(result.rows).toHaveLength(120);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["funil de oportunidades"]);
    expect(chain.limit).toHaveBeenCalledWith(121);
  });
});

export {};

