import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function chain(rows: unknown[]) {
  const result = Promise.resolve(rows);
  return { from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => result) })) })) };
}

describe("atomicidade da criação de oportunidade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não audita oportunidade quando o follow-up automático falha", async () => {
    const select = vi.fn()
      .mockImplementationOnce(() => chain([{ id: 10 }]))
      .mockImplementationOnce(() => chain([{ id: 55 }]));
    const taskInsert = vi.fn(() => ({ values: vi.fn().mockRejectedValue(new Error("falha no follow-up")) }));
    const opportunityInsert = vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 700 }] })) }));
    const tx = { insert: vi.fn()
      .mockImplementationOnce(() => opportunityInsert())
      .mockImplementationOnce(() => taskInsert()) };
    const db = { select, transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createOpportunity({ customerId: 10, title: "Oportunidade atomicamente protegida", expectedAmount: 5000, stage: "qualified" })).rejects.toThrow("falha no follow-up");
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });
});

