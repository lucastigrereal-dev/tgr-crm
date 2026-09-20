import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { operationsRouter } from "./routers/operations";

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

describe("integridade da lista de acompanhantes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("expõe truncamento quando a reserva tem mais de cem acompanhantes", async () => {
    const rows = Array.from({ length: 101 }, (_, id) => ({ id, reservationId: 44, fullName: `Acompanhante ${id}`, checkedInAt: null, checkedOutAt: null }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = operationsRouter.createCaller({ user: { id: 9, role: "service" } } as never);

    const result = await caller.reservationGuests({ reservationId: 44 });

    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["acompanhantes"]);
    expect(db.limitCalls).toEqual([101]);
  });
});

export {};
