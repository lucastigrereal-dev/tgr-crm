import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function makeDb(status: "open" | "paid" | "cancelled") {
  const rows = [{ id: 91, contractId: 61, sequence: 2, amount: "1000.00", status }];
  const query = () => {
    const chain = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
      for: vi.fn(async () => rows),
      then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    };
    chain.from.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    return chain;
  };
  const tx = { select: vi.fn(() => query()), insert: vi.fn() };
  return {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    insert: vi.fn(),
  };
}

describe("integridade de renegociação", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita renegociação de parcela cancelada sem inserir nem auditar", async () => {
    const db = makeDb("cancelled");
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.createRenegotiation({
      installmentId: 91,
      proposedAmount: 800,
      proposedDueDate: "2026-10-10",
      notes: "Tentativa inválida",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });
});

