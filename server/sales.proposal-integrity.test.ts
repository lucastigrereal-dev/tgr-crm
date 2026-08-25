import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function makeDb(opportunityExists: boolean, duplicateReference = false, affectedRows?: number) {
  let selectCall = 0;
  const select = vi.fn(() => {
    const result = Promise.resolve(selectCall++ === 0 ? (opportunityExists ? [{ id: 11 }] : []) : (duplicateReference ? [{ id: 702 }] : []));
    const limitChain = { for: vi.fn(async () => result), then: result.then.bind(result) };
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => limitChain),
    };
    return chain;
  });
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ $returningId: async () => [{ id: 701 }] })),
  }));
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => affectedRows === undefined ? undefined : { affectedRows }) })) }));
  const transaction = vi.fn(async (callback: (tx: { select: typeof select; insert: typeof insert; update: typeof update }) => Promise<unknown>) => callback({ select, insert, update }));
  return { select, insert, update, transaction };
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

  it("rejeita referência de proposta duplicada antes do insert", async () => {
    const db = makeDb(true, true);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createProposal({
      opportunityId: 11,
      reference: "PROP-11",
      productDescription: "Proposta duplicada",
      totalAmount: 1000,
      downPaymentAmount: 100,
      installmentCount: 10,
      status: "draft",
      expiresAt: null,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("mantém o fluxo válido quando a oportunidade existe", async () => {
    const db = makeDb(true, false, 1);
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

  it("rejeita proposta quando o avanço da oportunidade perde a corrida", async () => {
    const db = makeDb(true, false, 0);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.createProposal({
      opportunityId: 11,
      reference: "PROP-RACE",
      productDescription: "Proposta concorrente",
      totalAmount: 1000,
      downPaymentAmount: 100,
      installmentCount: 10,
      status: "draft",
      expiresAt: null,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});
