import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const storageMocks = vi.hoisted(() => ({ storagePut: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./storage", () => storageMocks);

import { contractsRouter } from "./routers/contracts";

function makeDb() {
  const tx = {
    insert: vi.fn((table: unknown) => ({ values: vi.fn(() => ({ $returningId: async () => table ? [{ id: 701 }] : [] })) })),
  };
  return {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<number>) => callback(tx)),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 702 }] })) })),
  };
}

function caller() {
  return contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

describe("eventos e auditoria de contratos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getDb.mockResolvedValue(makeDb());
    storageMocks.storagePut.mockResolvedValue({ key: "contracts/701/contrato.pdf", url: "https://storage.example/contrato.pdf" });
  });

  it("registra criação contratual com valor, parcelas e ator", async () => {
    await expect(caller().create({ number: "TS-2026-701", customerId: 11, proposalId: null, usageModel: "flexible_week", status: "active", totalAmount: 12000, firstDueDate: "2026-09-10", installmentCount: 12 })).resolves.toEqual({ id: 701 });

    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "contract", 701, "created", expect.stringContaining("TS-2026-701"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "contract.created", aggregateType: "contract", aggregateId: 701, actorUserId: 55, payload: expect.objectContaining({ customerId: 11, status: "active", totalAmount: 12000, installmentCount: 12 }) }));
  });

  it("registra mudança de status e documento contratual com trilha de auditoria", async () => {
    await caller().updateStatus({ id: 701, status: "cancelled", cancellationReason: "Solicitação documentada" });
    await caller().uploadDocument({ contractId: 701, category: "Contrato assinado", filename: "contrato.pdf", contentType: "application/pdf", signed: true, base64: "data:application/pdf;base64,MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" });

    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: 701, actorUserId: 55, payload: { status: "cancelled", cancellationReason: "Solicitação documentada" } }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "contract_document", 702, "uploaded", expect.stringContaining("contrato.pdf"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "contract.document.uploaded", aggregateType: "contract_document", aggregateId: 702, actorUserId: 55, payload: { contractId: 701, category: "Contrato assinado", signed: true, filename: "contrato.pdf" } }));
  });
});
