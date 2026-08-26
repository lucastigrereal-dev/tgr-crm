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

describe("integridade da lista de recebíveis", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca a amostra quando existem mais parcelas que o limite solicitado", async () => {
    const rows = Array.from({ length: 301 }, (_, id) => ({
      installment: { id, dueDate: new Date("2026-09-01T12:00:00Z"), status: "open", amount: "100.00", sequence: 1 },
      contractNumber: `CTR-${id}`,
      customerName: `Cliente ${id}`,
    }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 5, role: "finance" } } as never);

    const result = await caller.installments({ limit: 300 });
    expect(result.rows).toHaveLength(300);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["recebíveis"]);
    expect(db.select.mock.results[0]?.value.limit).toHaveBeenCalledWith(301);
  });
});

export {};

