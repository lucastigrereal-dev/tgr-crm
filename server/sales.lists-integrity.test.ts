import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function queryChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async () => rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

describe("integridade das listas comerciais", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca propostas quando a lista excede o limite operacional", async () => {
    const rows = Array.from({ length: 101 }, (_, id) => ({
      proposal: { id, status: "sent" },
      opportunityTitle: `Oportunidade ${id}`,
      customerName: "Cliente",
    }));
    const chain = queryChain(rows);
    dbMocks.getDb.mockResolvedValue({ select: vi.fn(() => chain) });
    const caller = salesRouter.createCaller({ user: { id: 1, role: "seller" } } as never);

    const result = await caller.proposals();
    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["propostas"]);
    expect(chain.limit).toHaveBeenCalledWith(101);
  });

  it("marca pedidos de desconto quando a fila excede o limite operacional", async () => {
    const rows = Array.from({ length: 501 }, (_, id) => ({
      approval: { id, status: "pending" },
      proposalReference: `PROP-${id}`,
      requesterName: "Vendedor",
    }));
    const chain = queryChain(rows);
    dbMocks.getDb.mockResolvedValue({ select: vi.fn(() => chain) });
    const caller = salesRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    const result = await caller.discountApprovals();
    expect(result.rows).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["pedidos de desconto"]);
    expect(chain.limit).toHaveBeenCalledWith(501);
  });
});

export {};

