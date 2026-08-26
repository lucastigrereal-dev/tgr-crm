import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function query(rows: unknown[]) {
  const chain = { from: vi.fn(), where: vi.fn(), limit: vi.fn(), for: vi.fn(), then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject) };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.for.mockReturnValue(chain);
  return chain;
}

function makeDb(duplicate = false, activeDuplicate = false, installmentStatus: "open" | "overdue" | "paid" | "cancelled" | "renegotiated" = "open") {
  const db = {
    select: vi.fn()
      .mockReturnValueOnce(query([{ id: 91, status: installmentStatus }]))
      .mockReturnValueOnce(query(duplicate ? [{ id: 700 }] : []))
      .mockReturnValueOnce(query(activeDuplicate ? [{ id: 701 }] : [])),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 701 }] })) })),
    transaction: vi.fn(async (callback: (transaction: typeof db) => Promise<unknown>) => callback(db)),
  };
  return db;
}

function makeIdempotentDb(existing: { id: number; installmentId: number; type: "card" | "transfer"; amount: string; dueDate: Date; externalReference: string | null }) {
  const db = {
    select: vi.fn().mockReturnValue(query([{ billing: existing }])),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 702 }] })) })),
    transaction: vi.fn(async (callback: (transaction: typeof db) => Promise<unknown>) => callback(db)),
  };
  return db;
}

function makeCollisionDb(existing: { id: number; installmentId: number; type: "card" | "transfer"; amount: string; dueDate: Date; externalReference: string | null }) {
  const duplicate = Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
  const db = {
    select: vi.fn()
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([{ id: 91, status: "open" }]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([{ billing: existing }])),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => { throw duplicate; } })) })),
    transaction: vi.fn(async (callback: (transaction: typeof db) => Promise<unknown>) => callback(db)),
  };
  return db;
}

describe("integridade de referências de cobrança", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita referência externa manual duplicada antes do insert", async () => {
    const db = makeDb(true);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.registerBilling({
      installmentId: 91,
      type: "card",
      amount: 1000,
      dueDate: "2026-09-10",
      externalReference: "MANUAL-91",
      digitableLine: null,
      pixCopyPaste: null,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita segunda cobrança manual ativa para a mesma parcela e tipo", async () => {
    const db = makeDb(false, true);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.registerBilling({
      installmentId: 91,
      type: "card",
      amount: 1000,
      dueDate: "2026-09-10",
      externalReference: "MANUAL-RETRY-91",
      digitableLine: null,
      pixCopyPaste: null,
    })).rejects.toMatchObject({ code: "CONFLICT", message: "Já existe uma cobrança manual ativa para esta parcela e tipo." });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("reutiliza cobrança manual no retry da mesma chave idempotente", async () => {
    const db = makeIdempotentDb({ id: 702, installmentId: 91, type: "card", amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z"), externalReference: "MANUAL-IDEMP-91" });
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.registerBilling({
      idempotencyKey: "billing-retry-key-91-abcdef",
      installmentId: 91,
      type: "card",
      amount: 1000,
      dueDate: "2026-09-10",
      externalReference: "MANUAL-IDEMP-91",
      digitableLine: null,
      pixCopyPaste: null,
    })).resolves.toEqual({ id: 702, reused: true });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("reutiliza cobrança criada pela operação concorrente após colisão unique", async () => {
    const db = makeCollisionDb({ id: 704, installmentId: 91, type: "card", amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z"), externalReference: "MANUAL-CORRIDA-91" });
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.registerBilling({
      idempotencyKey: "billing-race-key-91-abcdef",
      installmentId: 91,
      type: "card",
      amount: 1000,
      dueDate: "2026-09-10",
      externalReference: "MANUAL-CORRIDA-91",
      digitableLine: null,
      pixCopyPaste: null,
    })).resolves.toEqual({ id: 704, reused: true });

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("recusa a mesma chave idempotente com payload diferente", async () => {
    const db = makeIdempotentDb({ id: 703, installmentId: 91, type: "card", amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z"), externalReference: "MANUAL-IDEMP-91" });
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.registerBilling({
      idempotencyKey: "billing-retry-key-91-abcdef",
      installmentId: 91,
      type: "card",
      amount: 1200,
      dueDate: "2026-09-10",
      externalReference: "MANUAL-IDEMP-91",
      digitableLine: null,
      pixCopyPaste: null,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("bloqueia cobrança manual para parcela renegociada", async () => {
    const db = makeDb(false, false, "renegotiated");
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.registerBilling({
      installmentId: 91,
      type: "card",
      amount: 1000,
      dueDate: "2026-09-10",
      externalReference: "MANUAL-RENEG-91",
      digitableLine: null,
      pixCopyPaste: null,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("registra cobrança manual com referência normalizada quando livre", async () => {
    const db = makeDb(false);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.registerBilling({
      installmentId: 91,
      type: "card",
      amount: 1000,
      dueDate: "2026-09-10",
      externalReference: "  MANUAL-91  ",
      digitableLine: "IGNORADA",
      pixCopyPaste: "IGNORADO",
    })).resolves.toEqual({ id: 701 });

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(71, "billing_record", 701, "registered", "Cobrança card registrada.");
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "financial.billing.created", aggregateType: "billing_record", aggregateId: 701 }));
  });
});

