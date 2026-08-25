import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function makeDb(opportunityExists: boolean) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => opportunityExists ? [{ id: 11 }] : []),
      })),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ $returningId: async () => [{ id: 701 }] })),
  }));
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) }));
  return { select, insert, update };
}

describe("integridade de propostas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejeita proposta sem oportunidade e não grava insert órfão", async () => {
    const db = makeDb(false);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createProposal({
      opportunityId: 999,
      reference: "PROP-999",
      productDescription: "Proposta de teste",
      totalAmount: 1000,
      downPaymentAmount: 100,
      installmentCount: 10,
      status: "draft",
      expiresAt: null,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("mantém o fluxo válido quando a oportunidade existe", async () => {
    const db = makeDb(true);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createProposal({
      opportunityId: 11,
      reference: "PROP-11",
      productDescription: "Proposta válida",
      totalAmount: 1000,
      downPaymentAmount: 100,
      installmentCount: 10,
      status: "draft",
      expiresAt: null,
    })).resolves.toEqual({ id: 701 });

    expect(db.insert).toHaveBeenCalled();
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "proposal", 701, "created", expect.stringContaining("PROP-11"));
  });
});
