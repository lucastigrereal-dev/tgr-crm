import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function makeDb() {
  let limitCalls = 0;
  const chain = {
    from: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async () => {
      limitCalls += 1;
      return limitCalls === 1
        ? [{ entry: { id: 1, type: "income", amount: "10.00" } }, { entry: { id: 2, type: "expense", amount: "5.00" } }, { entry: { id: 3, type: "income", amount: "20.00" } }]
        : [{ income: "130.00", expense: "45.50" }];
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain) };
}

describe("integridade do livro-caixa", () => {
  beforeEach(() => vi.clearAllMocks());

  it("devolve totais completos e marca a amostra recente quando excede o limite", async () => {
    const db = makeDb();
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 5, role: "finance" } } as never);

    await expect(caller.entries({ type: "income", limit: 2 })).resolves.toMatchObject({
      rows: [{ entry: { id: 1 } }, { entry: { id: 2 } }],
      totals: { income: 130, expense: 45.5 },
      truncated: true,
    });
    expect(db.select).toHaveBeenCalledTimes(2);
    const limitMock = db.select.mock.results[0]?.value.limit;
    expect(limitMock).toHaveBeenNthCalledWith(1, 3);
    expect(limitMock).toHaveBeenNthCalledWith(2, 1);
  });
});

export {};

