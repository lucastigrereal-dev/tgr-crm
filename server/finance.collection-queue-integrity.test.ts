import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function makeDb(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async () => rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain) };
}

describe("integridade da fila de cobrança", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca fila parcial quando supera o limite operacional", async () => {
    const rows = Array.from({ length: 121 }, (_, id) => ({
      installment: { id, dueDate: new Date("2026-09-01T12:00:00Z"), status: "overdue", amount: "100.00", sequence: 1 },
      contractNumber: `CTR-${id}`,
      customerName: `Cliente ${id}`,
    }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 5, role: "finance" } } as never);

    const result = await caller.collectionQueue();
    expect(result.rows).toHaveLength(120);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["fila de cobrança"]);
    expect(db.select.mock.results[0]?.value.limit).toHaveBeenCalledWith(121);
  });
});

export {};

