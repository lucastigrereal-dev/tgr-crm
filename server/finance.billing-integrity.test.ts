import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function query(rows: unknown[]) {
  return { from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => rows) })) })) };
}

function makeDb(duplicate = false) {
  return {
    select: vi.fn(() => query(duplicate ? [{ id: 700 }] : [])),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 701 }] })) })),
  };
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
  });
});

