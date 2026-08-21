import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

describe("carteira financeira", () => {
  beforeEach(() => vi.clearAllMocks());

  it("encerra o responsável ativo e abre uma nova atribuição auditável", async () => {
    const updates: unknown[] = [];
    const inserts: unknown[] = [];
    const selects = [[{ id: 41 }], [{ id: 7 }]];
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => selects.shift() ?? [] }) }) }));
    const tx = {
      update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => updates.push(value)) })) })),
      insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { inserts.push(value); return { $returningId: async () => [{ id: 901 }] }; }) })),
    };
    dbMocks.getDb.mockResolvedValue({ select, transaction: async (callback: (transaction: typeof tx) => Promise<number>) => callback(tx) });
    const caller = financeRouter.createCaller({ user: { id: 3, role: "finance" } } as never);

    await expect(caller.assignPortfolioOwner({ contractId: 41, ownerUserId: 7, notes: "Carteira de agosto" })).resolves.toEqual(expect.objectContaining({ id: 901, contractId: 41, ownerUserId: 7, startsAt: expect.any(Date) }));
    expect(updates[0]).toEqual(expect.objectContaining({ endsAt: expect.any(Date) }));
    expect(inserts[0]).toEqual(expect.objectContaining({ contractId: 41, ownerUserId: 7, assignedByUserId: 3, notes: "Carteira de agosto", startsAt: expect.any(Date) }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(3, "financial_portfolio_assignment", 901, "assigned", expect.stringContaining("41"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "financial.portfolio.assigned", aggregateId: 901, actorUserId: 3, payload: { contractId: 41, ownerUserId: 7 } }));
  });
});
