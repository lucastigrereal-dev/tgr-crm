import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { contractsRouter } from "./routers/contracts";

function makeDb(row: { status: "requested" | "approved" | "rejected" | "executed" | "cancelled" } | null, affectedRows = 1) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => row ? [row] : []),
      })),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows })) })),
  }));
  return { select, update };
}

function caller() {
  return contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

describe("integridade da decisão de distrato", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita solicitação inexistente sem atualizar ou auditar", async () => {
    const db = makeDb(null);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().decideCancellation({ requestId: 901, decision: "approved" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita solicitação já decidida sem repetir decisão", async () => {
    const db = makeDb({ status: "approved" });
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().decideCancellation({ requestId: 901, decision: "rejected" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("não audita quando a atualização condicional perde uma corrida", async () => {
    const db = makeDb({ status: "requested" }, 0);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().decideCancellation({ requestId: 901, decision: "approved" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("decide solicitação pendente e registra auditoria uma única vez", async () => {
    const db = makeDb({ status: "requested" }, 1);
    dbMocks.getDb.mockResolvedValue(db);

    await expect(caller().decideCancellation({ requestId: 901, decision: "approved", notes: "Validado" })).resolves.toEqual({ success: true });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "contract_cancellation_request", 901, "approved", "Distrato approved.");
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith({ eventName: "contract.cancellation.decided", aggregateType: "contract_cancellation_request", aggregateId: 901, actorUserId: 55, payload: { decision: "approved" } });
  });
});
