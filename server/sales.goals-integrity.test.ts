import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function makeDb(sellerExists: boolean, duplicateGoal = false) {
  let selectCall = 0;
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          const rows = selectCall++ === 0
            ? (sellerExists ? [{ id: 21 }] : [])
            : (duplicateGoal ? [{ id: 901 }] : []);
          return rows;
        }),
      })),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ $returningId: async () => [{ id: 902 }] })),
  }));
  return { select, insert };
}

describe("integridade de metas comerciais", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejeita meta para vendedor inexistente sem inserir nem auditar", async () => {
    const db = makeDb(false);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createGoal({
      sellerId: 999,
      monthReference: "2026-08-01",
      targetAmount: 10000,
      targetContracts: 2,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita meta para usuário fora da equipe de vendas antes do insert", async () => {
    const db = makeDb(false);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createGoal({
      sellerId: 21,
      monthReference: "2026-08-01",
      targetAmount: 10000,
      targetContracts: 2,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita meta duplicada para o mesmo vendedor e mês antes do insert", async () => {
    const db = makeDb(true, true);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createGoal({
      sellerId: 21,
      monthReference: "2026-08-01",
      targetAmount: 12000,
      targetContracts: 3,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("insere e audita uma meta válida quando vendedor e mês estão livres", async () => {
    const db = makeDb(true, false);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createGoal({
      sellerId: 21,
      monthReference: "2026-08-01",
      targetAmount: 15000,
      targetContracts: 4,
    })).resolves.toEqual({ id: 902 });

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_goal", 902, "created", expect.stringContaining("2026-08-01"));
  });
});

