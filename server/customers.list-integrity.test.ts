import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { customersRouter } from "./routers/customers";

function makeDb(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async (value: number) => {
      expect(value).toBe(101);
      return rows;
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain), chain };
}

describe("integridade da lista de clientes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca associados além do limite operacional", async () => {
    const rows = Array.from({ length: 101 }, (_, id) => ({ id, fullName: `Associado ${id}`, status: "active" }));
    const fixture = makeDb(rows);
    dbMocks.getDb.mockResolvedValue({ select: fixture.select });
    const caller = customersRouter.createCaller({ user: { id: 8, role: "service" } } as never);

    const result = await caller.list({ limit: 100, status: "active" });
    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["clientes"]);
    expect(fixture.chain.limit).toHaveBeenCalledWith(101);
  });
});

export {};
