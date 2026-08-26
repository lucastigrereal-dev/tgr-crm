import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const syncMocks = vi.hoisted(() => ({ syncRevenueQualityForContract: vi.fn(async () => ({})) }));
vi.mock("./db", () => dbMocks);
vi.mock("./revenueQualitySync", () => syncMocks);

import { financeRouter } from "./routers/finance";

function query(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, ReturnType<typeof vi.fn>>;
  promise.from = vi.fn(() => promise);
  promise.where = vi.fn(() => promise);
  promise.orderBy = vi.fn(() => promise);
  promise.limit = vi.fn(() => promise);
  return promise;
}

describe("idempotência concorrente de baixa de parcela", () => {
  beforeEach(() => vi.clearAllMocks());

  it("escolhe a captura mais recente antes de calcular os efeitos da baixa", async () => {
    const captureQuery = query([
      { id: 100, opportunityId: 51, resortId: 2, campaignId: 8, linerId: 10, closerId: 11 },
      { id: 101, opportunityId: 51, resortId: 2, campaignId: 9, linerId: 12, closerId: 13 },
    ]);
    const tx = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })) })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([{ id: 91, contractId: 61, sequence: 2, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z"), status: "open" }]))
        .mockReturnValueOnce(query([{ id: 61, proposalId: 41, totalAmount: "10000.00" }]))
        .mockReturnValueOnce(query([{ id: 41, opportunityId: 51, downPaymentAmount: "1000.00" }]))
        .mockReturnValueOnce(query([{ id: 51 }]))
        .mockReturnValueOnce(captureQuery)
        .mockReturnValueOnce(query([])),
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "admin" } } as never);

    await expect(caller.markInstallmentPaid({ id: 91, paymentMethod: "pix" })).resolves.toEqual({ success: true, alreadyPaid: false, commissionBlocked: true });

    expect(captureQuery.orderBy).toHaveBeenCalledTimes(1);
    expect(syncMocks.syncRevenueQualityForContract).toHaveBeenCalledWith({ contractId: 61, actorUserId: 71, trigger: "baixa de parcela" });
  });

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

