import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { dashboardRouter } from "./routers/dashboard";

function makeDb(rows: unknown[]) {
  const limitCalls: number[] = [];
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async (value: number) => {
      limitCalls.push(value);
      return rows;
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain), limitCalls };
}

describe("integridade dos recortes salvos", () => {
  beforeEach(() => vi.clearAllMocks());

  it("expõe truncamento quando há mais de duzentos recortes visíveis", async () => {
    const rows = Array.from({ length: 201 }, (_, id) => ({ id, name: `Recorte ${id}`, scope: "dashboard", createdByUserId: 99, visibility: "personal", filtersJson: "{}", updatedAt: new Date() }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = dashboardRouter.createCaller({ user: { id: 99, role: "finance" } } as never);

    const result = await caller.savedViews();

    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["recortes salvos"]);
    expect(db.limitCalls).toEqual([201]);
  });
});

export {};
