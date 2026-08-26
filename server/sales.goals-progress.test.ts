import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function makeDb() {
  const goalRows = [{
    goal: {
      id: 1,
      sellerId: 21,
      monthReference: new Date("2026-08-01T12:00:00Z"),
      targetAmount: "10000.00",
      targetContracts: 3,
      createdAt: new Date("2026-07-01T12:00:00Z"),
    },
    sellerName: "Ana",
  }];
  const wonOpportunities = [
    { id: 10, sellerId: 21, expectedAmount: "1200.00", closedAt: new Date("2026-08-05T10:00:00Z") },
    { id: 11, sellerId: 21, expectedAmount: "800.00", closedAt: new Date("2026-08-27T10:00:00Z") },
    { id: 12, sellerId: 21, expectedAmount: "500.00", closedAt: new Date("2026-07-31T10:00:00Z") },
    { id: 13, sellerId: 22, expectedAmount: "900.00", closedAt: new Date("2026-08-12T10:00:00Z") },
  ];
  let selectCall = 0;
  const select = vi.fn(() => {
    const chain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      orderBy: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.orderBy.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.limit.mockResolvedValue(selectCall++ === 0 ? goalRows : wonOpportunities);
    return chain;
  });
  return { select };
}

describe("progresso de metas comerciais", () => {
  beforeEach(() => vi.clearAllMocks());

  it("agrega oportunidades ganhas uma vez por vendedor e mês", async () => {
    const db = makeDb();
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.goals()).resolves.toMatchObject({
      rows: [{
        sellerName: "Ana",
        currentAmount: 2000,
        currentContracts: 2,
      }],
      truncated: false,
      truncatedSources: [],
    });
  });

  it("usa uma linha extra para detectar truncamento de metas e progresso", async () => {
    const goalRows = Array.from({ length: 1001 }, (_, id) => ({
      goal: {
        id,
        sellerId: 21,
        monthReference: new Date("2026-08-01T12:00:00Z"),
        targetAmount: "10000.00",
        targetContracts: 3,
      },
      sellerName: "Ana",
    }));
    const wonOpportunities = Array.from({ length: 5001 }, (_, id) => ({
      id,
      sellerId: 21,
      expectedAmount: "1.00",
      closedAt: new Date("2026-08-05T10:00:00Z"),
    }));
    const limitCalls: number[] = [];
    let selectCall = 0;
    const select = vi.fn(() => {
      const chain = {
        from: vi.fn(),
        innerJoin: vi.fn(),
        orderBy: vi.fn(),
        where: vi.fn(),
        limit: vi.fn((value: number) => {
          limitCalls.push(value);
          return Promise.resolve(selectCall++ === 0 ? goalRows : wonOpportunities);
        }),
      };
      chain.from.mockReturnValue(chain);
      chain.innerJoin.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      return chain;
    });
    dbMocks.getDb.mockResolvedValue({ select });
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    const result = await caller.goals();
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["metas", "oportunidades ganhas"]);
    expect(limitCalls).toEqual([1001, 5001]);
  });
});

