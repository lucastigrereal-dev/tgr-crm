import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

const data = {
  customerId: 10,
  sellerId: 20,
  campaignId: 30,
  title: "Oportunidade atualizada",
  stage: "qualified" as const,
  source: "indicação",
  expectedAmount: 5000,
  probability: 30,
  nextFollowUpAt: null,
  lossReason: null,
};

function makeDb(selectRows: unknown[][], affectedRows?: number) {
  let selectCall = 0;
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => selectRows[selectCall++] ?? []),
      })),
    })),
  }));
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => affectedRows === undefined ? undefined : { affectedRows }) })) }));
  return { select, update };
}

function caller() {
  return salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

describe("integridade da atualização de oportunidade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bloqueia cliente inexistente antes de atualizar", async () => {
    const db = makeDb([[{ stage: "new" }], []]);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().updateOpportunity({ id: 701, data })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("bloqueia vendedor inexistente antes de atualizar", async () => {
    const db = makeDb([[{ stage: "new" }], [{ id: 10 }], []]);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().updateOpportunity({ id: 701, data })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("bloqueia campanha inexistente antes de atualizar", async () => {
    const db = makeDb([[{ stage: "new" }], [{ id: 10 }], [{ id: 20 }], []]);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().updateOpportunity({ id: 701, data })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("atualiza oportunidade válida e registra a transição", async () => {
    const db = makeDb([[{ stage: "new" }], [{ id: 10 }], [{ id: 20 }], [{ id: 30 }]], 1);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().updateOpportunity({ id: 701, data })).resolves.toEqual({ success: true });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "opportunity", 701, "updated", "Oportunidade atualizada para qualified.");
  });

  it("não audita atualização de oportunidade que perdeu a corrida", async () => {
    const db = makeDb([[{ stage: "new" }], [{ id: 10 }], [{ id: 20 }], [{ id: 30 }]], 0);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().updateOpportunity({ id: 701, data })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});
