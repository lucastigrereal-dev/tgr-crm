import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function makeDb(status: "open" | "paid" | "cancelled") {
  return {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: 91, contractId: 61, sequence: 2, amount: "1000.00", status }]) })) })) })),
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

