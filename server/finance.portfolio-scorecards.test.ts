import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => ({ ...dbMocks, recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));

import { financeRouter } from "./routers/finance";

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, () => unknown>;
  promise.from = () => promise;
  promise.leftJoin = () => promise;
  promise.where = () => promise;
  promise.groupBy = () => promise;
  promise.limit = () => promise;
  return promise;
}

describe("finance.portfolioScorecards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("agrega carteira ativa, saldo, atraso e recuperação posterior à posse", async () => {
    const responses = [
      [{ ownerUserId: 4, assignedContracts: 1, openAmount: "300.00", overdueAmount: "300.00", recoveredAfterAssignment: "200.00", assignedSince: new Date("2026-08-10T12:00:00Z") }],
      [{ id: 4, name: "Fábio Financeiro", email: "fabio@tgr.local" }],
    ];
    dbMocks.getDb.mockResolvedValue({ select: vi.fn(() => chain(responses.shift() ?? [])) });
    const caller = financeRouter.createCaller({ user: { id: 1, role: "finance" } } as never);

    await expect(caller.portfolioScorecards()).resolves.toEqual([expect.objectContaining({ ownerUserId: 4, ownerName: "Fábio Financeiro", assignedContracts: 1, recoveredAfterAssignment: 200, overdueAmount: 300, openAmount: 300, regularizationRate: 40 })]);
  });
});
