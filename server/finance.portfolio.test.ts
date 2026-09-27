import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function query<T>(rows: T) {
  const promise = Promise.resolve(rows) as Promise<T> & Record<string, (...args: unknown[]) => unknown>;
  for (const method of ["from", "leftJoin", "where", "groupBy", "limit"]) promise[method] = () => promise;
  return promise;
}

describe("carteira financeira", () => {
  beforeEach(() => vi.clearAllMocks());

  it("conta somente o caixa recebido depois da atribuição", async () => {
    const assignmentRows = [{
      assignmentId: 901,
      ownerUserId: 7,
      contractId: 41,
      paidAmountBaseline: "900.00",
      startsAt: new Date("2026-09-01T12:00:00Z"),
      openAmount: "0.00",
      overdueAmount: "0.00",
      currentPaidAmount: "1000.00",
    }];
    const owners = [{ id: 7, name: "Financeiro 7", email: null }];
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query(assignmentRows))
        .mockReturnValueOnce(query(owners)),
    };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 3, role: "finance" } } as never);

    await expect(caller.portfolioScorecards()).resolves.toEqual([expect.objectContaining({
      ownerUserId: 7,
      assignedContracts: 1,
      recoveredAfterAssignment: 100,
      regularizationRate: 100,
    })]);
  });

  it("encerra o responsável ativo e abre uma nova atribuição auditável", async () => {
    const updates: unknown[] = [];
    const inserts: unknown[] = [];
    const selects = [[{ id: 41 }], [{ id: 7 }]];
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => selects.shift() ?? [] }) }) }));
    let txSelectIndex = 0;
    const tx = {
      select: vi.fn(() => {
        txSelectIndex += 1;
        if (txSelectIndex === 1) return { from: () => ({ where: () => ({ limit: () => ({ for: async () => [{ id: 41 }] }) }) }) };
        return { from: () => ({ where: async () => [{ paidAmountBaseline: "900.00" }] }) };
      }),
      update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => updates.push(value)) })) })),
      insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { inserts.push(value); return { $returningId: async () => [{ id: 901 }] }; }) })),
    };
    dbMocks.getDb.mockResolvedValue({ select, transaction: async (callback: (transaction: typeof tx) => Promise<number>) => callback(tx) });
    const caller = financeRouter.createCaller({ user: { id: 3, role: "finance" } } as never);

    await expect(caller.assignPortfolioOwner({ contractId: 41, ownerUserId: 7, notes: "Carteira de agosto" })).resolves.toEqual(expect.objectContaining({ id: 901, contractId: 41, ownerUserId: 7, startsAt: expect.any(Date) }));
    expect(updates[0]).toEqual(expect.objectContaining({ endsAt: expect.any(Date) }));
    expect(inserts[0]).toEqual(expect.objectContaining({ contractId: 41, ownerUserId: 7, assignedByUserId: 3, paidAmountBaseline: "900.00", notes: "Carteira de agosto", startsAt: expect.any(Date) }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(3, "financial_portfolio_assignment", 901, "assigned", expect.stringContaining("41"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "financial.portfolio.assigned", aggregateId: 901, actorUserId: 3, payload: { contractId: 41, ownerUserId: 7 } }));
  });

  it("rejeita responsável fora dos papéis financeiro/admin antes da transação", async () => {
    const selects = [[{ id: 41 }], []];
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => selects.shift() ?? [] }) }) }));
    const transaction = vi.fn();
    dbMocks.getDb.mockResolvedValue({ select, transaction });
    const caller = financeRouter.createCaller({ user: { id: 3, role: "finance" } } as never);

    await expect(caller.assignPortfolioOwner({ contractId: 41, ownerUserId: 7 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(transaction).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("aborta se o contrato desaparecer antes do lock transacional", async () => {
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 41 }] }) }) }));
    const updates: unknown[] = [];
    const inserts: unknown[] = [];
    const tx = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [] }) }) }) })),
      update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => updates.push(value)) })) })),
      insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { inserts.push(value); return { $returningId: async () => [{ id: 901 }] }; }) })),
    };
    dbMocks.getDb.mockResolvedValue({ select, transaction: async (callback: (transaction: typeof tx) => Promise<number>) => callback(tx) });
    const caller = financeRouter.createCaller({ user: { id: 3, role: "finance" } } as never);

    await expect(caller.assignPortfolioOwner({ contractId: 41, ownerUserId: 7 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});
