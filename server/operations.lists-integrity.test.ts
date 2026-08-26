import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { operationsRouter } from "./routers/operations";

function queryChain(rows: unknown[]) {
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
  return chain;
}

describe("integridade das listas operacionais", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca reservas quando a consulta supera o limite operacional", async () => {
    const rows = Array.from({ length: 201 }, (_, id) => ({
      reservation: { id, status: "confirmed" },
      customerName: "Hóspede",
      contractNumber: "CTR-1",
      unitCode: "A-101",
      resortName: "Resort",
    }));
    const chain = queryChain(rows);
    dbMocks.getDb.mockResolvedValue({ select: vi.fn(() => chain) });
    const caller = operationsRouter.createCaller({ user: { id: 1, role: "service" } } as never);

    const result = await caller.reservations();
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["reservas"]);
    expect(chain.limit).toHaveBeenCalledWith(201);
  });

  it("marca fila de espera quando há posições além do limite", async () => {
    const rows = Array.from({ length: 201 }, (_, id) => ({
      item: { id, status: "waiting", priorityScore: 10 },
      customerName: "Associado",
      resortName: "Resort",
    }));
    const chain = queryChain(rows);
    dbMocks.getDb.mockResolvedValue({ select: vi.fn(() => chain) });
    const caller = operationsRouter.createCaller({ user: { id: 1, role: "service" } } as never);

    const result = await caller.waitlist();
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["fila de espera"]);
    expect(chain.limit).toHaveBeenCalledWith(201);
  });
});

export {};

