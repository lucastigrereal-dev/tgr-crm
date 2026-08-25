import { beforeEach, describe, expect, it, vi } from "vitest";
import { salesCommissions } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { commissionsRouter } from "./routers/commissions";

function makeDb(rows: unknown[], affectedRows = 1) {
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      if (table !== salesCommissions) throw new Error("Tabela não prevista neste teste");
      return { where: vi.fn(() => ({ limit: vi.fn(async () => rows) })) };
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows })) })),
  }));
  return { db: { select, update }, update };
}

function caller() {
  return commissionsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

describe("integridade do status de comissão", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita comissão inexistente sem atualizar ou auditar", async () => {
    const fixture = makeDb([]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita corrida perdida sem auditar alteração falsa", async () => {
    const fixture = makeDb([{ contractId: null, status: "pending" }], 0);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("atualiza comissão existente e audita uma única vez", async () => {
    const fixture = makeDb([{ contractId: null, status: "pending" }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).resolves.toEqual({ success: true });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_commission", 901, "approved", "Comissão marcada como approved.");
  });
});

