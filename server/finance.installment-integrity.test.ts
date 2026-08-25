import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function query(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
    })),
  };
}

describe("idempotência concorrente de baixa de parcela", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não cria lançamento nem audita quando a atualização condicional perde a corrida", async () => {
    const txUpdate = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 0 })) })),
    }));
    const txInsert = vi.fn();
    const tx = { update: txUpdate, insert: txInsert };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([{ id: 91, contractId: 61, sequence: 2, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z"), status: "open" }]))
        .mockReturnValueOnce(query([{ id: 61, proposalId: null }])),
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "admin" } } as never);

    await expect(caller.markInstallmentPaid({ id: 91 })).resolves.toEqual({ success: true, alreadyPaid: true, commissionBlocked: false });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });
});

