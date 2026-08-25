import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function query(rows: unknown[]) {
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
}

function makeDb(pending = false) {
  let selectCall = 0;
  const txInsert = vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 801 }] })) }));
  const tx = {
    select: vi.fn(() => selectCall++ === 0 ? query([{ id: 41, totalAmount: "1000.00" }]) : query(pending ? [{ id: 802 }] : [])),
    insert: txInsert,
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { db, txInsert };
}

describe("integridade de solicitação de desconto", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita segunda solicitação pendente para a mesma proposta", async () => {
    const fixture = makeDb(true);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createDiscountRequest({ proposalId: 41, requestedAmount: 800, rationale: "Ajuste comercial validado pelo responsável." })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(fixture.txInsert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("cria e audita solicitação quando não há pendência", async () => {
    const fixture = makeDb(false);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createDiscountRequest({ proposalId: 41, requestedAmount: 800, rationale: "Ajuste comercial validado pelo responsável." })).resolves.toEqual({ id: 801, discountPercent: 20 });

    expect(fixture.txInsert).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "proposal_discount", 801, "requested", expect.stringContaining("20.00%"));
  });
});

