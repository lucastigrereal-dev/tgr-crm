import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function query(row: unknown) {
  const rows = row ? [row] : [];
  const limitChain = { for: vi.fn(async () => rows), then: Promise.resolve(rows).then.bind(Promise.resolve(rows)) };
  return { from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => limitChain) })) })) };
}

describe("idempotência concorrente de repasse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não audita quando outra baixa de repasse vence a corrida", async () => {
    const updates: unknown[] = [];
    const db = {
      select: vi.fn(() => query({ id: 41, status: "pending" })),
      update: vi.fn(() => ({
        set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); return { affectedRows: 0 }; }) })),
      })),
      transaction: vi.fn(async (callback: (tx: { select: typeof db.select; update: typeof db.update }) => Promise<unknown>) => callback({ select: db.select, update: db.update })),
    };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "admin" } } as never);

    await expect(caller.markTransferPaid({ id: 41 })).resolves.toEqual({ success: true, alreadyPaid: true });

    expect(updates).toEqual([{ status: "paid", paidAt: expect.any(Date) }]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("recusa pagar repasse cancelado e não audita", async () => {
    const updates: unknown[] = [];
    const db = {
      select: vi.fn(() => query({ id: 42, status: "cancelled" })),
      update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); return { affectedRows: 1 }; }) })) })),
      transaction: vi.fn(async (callback: (tx: { select: typeof db.select; update: typeof db.update }) => Promise<unknown>) => callback({ select: db.select, update: db.update })),
    };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "admin" } } as never);

    await expect(caller.markTransferPaid({ id: 42 })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updates).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});

