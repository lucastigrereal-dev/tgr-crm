import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { salesRouter } from "./routers/sales";

function makeDb(row: { proposalId?: number; status: "pending" | "approved" | "rejected"; requestedAmount?: string } | null, affectedRows = 1) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => row ? [{ proposalId: 300, requestedAmount: "800.00", ...row }] : []),
      })),
    })),
  }));
  const set = vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows })) }));
  const update = vi.fn(() => ({ set }));
  return { select, update, set };
}

function caller() {
  return salesRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

describe("integridade de decisão de desconto", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita pedido inexistente sem atualizar ou auditar", async () => {
    const db = makeDb(null);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().decideDiscount({ id: 901, approve: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita pedido já decidido sem repetir decisão", async () => {
    const db = makeDb({ status: "approved" });
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().decideDiscount({ id: 901, approve: false })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("não audita quando a atualização condicional perde uma corrida", async () => {
    const db = makeDb({ status: "pending" }, 0);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().decideDiscount({ id: 901, approve: true })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("decide pedido pendente e registra a auditoria uma única vez", async () => {
    const db = makeDb({ status: "pending" }, 1);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().decideDiscount({ id: 901, approve: true, decisionNotes: "Validado" })).resolves.toEqual({ success: true });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: "approved", approvedAmount: "800.00" }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "proposal_discount", 901, "approved", "Pedido de desconto decidido pela administração.");
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith({ eventName: "proposal.discount.decided", aggregateType: "proposal_discount", aggregateId: 901, actorUserId: 55, payload: { proposalId: 300, status: "approved", approvedAmount: 800 } });
  });
});
