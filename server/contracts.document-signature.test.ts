import { beforeEach, describe, expect, it, vi } from "vitest";
import { contractDocuments } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { contractsRouter } from "./routers/contracts";

function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return chain;
}

function makeDb({ signed = false, affectedRows = 1 } = {}) {
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => ({ affectedRows })),
    })),
  }));
  return {
    select: vi.fn(() => query([{ id: 702, contractId: 701, signed }])),
    update,
  };
}

describe("confirmação administrativa de assinatura documental", () => {
  beforeEach(() => vi.clearAllMocks());

  it("confirma assinatura uma única vez com auditoria e evento", async () => {
    const db = makeDb();
    dbMocks.getDb.mockResolvedValue(db);
    const caller = contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.markDocumentSigned({ documentId: 702 })).resolves.toEqual({ success: true, alreadySigned: false });

    expect(db.update).toHaveBeenCalledWith(contractDocuments);
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "contract_document", 702, "signed", expect.stringContaining("confirmada"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "contract.document.signed", aggregateType: "contract_document", aggregateId: 702, actorUserId: 55, payload: { contractId: 701 } }));
  });

  it("torna retry idempotente quando documento já está assinado", async () => {
    const db = makeDb({ signed: true });
    dbMocks.getDb.mockResolvedValue(db);
    const caller = contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.markDocumentSigned({ documentId: 702 })).resolves.toEqual({ success: true, alreadySigned: true });

    expect(db.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("não audita quando outra confirmação vence a corrida", async () => {
    const db = makeDb({ affectedRows: 0 });
    dbMocks.getDb.mockResolvedValue(db);
    const caller = contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);

    await expect(caller.markDocumentSigned({ documentId: 702 })).resolves.toEqual({ success: true, alreadySigned: true });

    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("não permite que vendedor confirme assinatura", async () => {
    const db = makeDb();
    dbMocks.getDb.mockResolvedValue(db);
    const caller = contractsRouter.createCaller({ user: { id: 71, role: "seller" } } as never);

    await expect(caller.markDocumentSigned({ documentId: 702 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.select).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});

export { contractDocuments };
