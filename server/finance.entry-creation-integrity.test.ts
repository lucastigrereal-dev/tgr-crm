import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function query(row: unknown) {
  const rows = row ? [row] : [];
  const limitChain = { then: Promise.resolve(rows).then.bind(Promise.resolve(rows)) };
  return { from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => limitChain) })) })) };
}

describe("idempotência de lançamentos financeiros", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reutiliza o lançamento em retry sem duplicar auditoria ou evento", async () => {
    let selectCalls = 0;
    const inserted: unknown[] = [];
    const existing = { id: 61, contractId: null, campaignId: null, type: "expense", category: "Taxa", description: "Taxa bancária", amount: "200.00", dueDate: null, status: "open" };
    const db = {
      select: vi.fn(() => query(++selectCalls === 1 ? null : existing)),
      insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { inserted.push(value); return { $returningId: vi.fn(async () => [{ id: 61 }]) }; }) })),
    };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);
    const input = { idempotencyKey: "entry-key-00000061", type: "expense" as const, category: "Taxa", description: "Taxa bancária", amount: 200, status: "open" as const };

    await expect(caller.createEntry(input)).resolves.toEqual({ id: 61, reused: false });
    await expect(caller.createEntry(input)).resolves.toEqual({ id: 61, reused: true });

    expect(inserted).toHaveLength(1);
    expect(dbMocks.recordAudit).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledTimes(1);
  });

  it("recusa a mesma chave idempotente para outro valor", async () => {
    const existing = { id: 62, contractId: null, campaignId: null, type: "income", category: "Venda", description: "Venda recebida", amount: "200.00", dueDate: null, status: "open" };
    const db = { select: vi.fn(() => query(existing)), insert: vi.fn() };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.createEntry({ idempotencyKey: "entry-key-00000062", type: "income", category: "Venda", description: "Venda recebida", amount: 250, status: "open" })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});

export {};

