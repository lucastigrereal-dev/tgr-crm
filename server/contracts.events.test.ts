import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const storageMocks = vi.hoisted(() => ({ storagePut: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./storage", () => storageMocks);

import { contractsRouter } from "./routers/contracts";

function makeDb(options: { requestStatus?: "requested" | "approved" | "rejected" | "executed" | "cancelled"; failAtUpdate?: number } = {}) {
  let selectCall = 0;
  let updateCall = 0;
  const financialEntries: Array<{ type: string; category: string; amount: string }> = [];
  const rows = (value: unknown[]) => Object.assign(value, { limit: async () => value });
  const tx = {
    insert: vi.fn((table: unknown) => ({ values: vi.fn((values: unknown) => { if (Array.isArray(values)) financialEntries.push(...values as Array<{ type: string; category: string; amount: string }>); return { $returningId: async () => table ? [{ id: 701 }] : [] }; }) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => {
      const data = [
        [{ id: 801, contractId: 701, status: options.requestStatus ?? "approved", reason: "Solicitação aprovada", decisionNotes: null, simulationSnapshot: JSON.stringify({ penalty: 120, retained: 120, refund: 80 }) }],
        [{ id: 701, status: "active" }],
        [{ id: 71, status: "open" }, { id: 72, status: "paid" }, { id: 73, status: "overdue" }],
        [{ id: 91, status: "pending" }, { id: 92, status: "paid" }, { id: 93, status: "approved" }],
      ][selectCall++] ?? [];
      return rows(data);
    }) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => { updateCall += 1; if (options.failAtUpdate === updateCall) throw new Error("rollback sentinel"); return [{ affectedRows: 2 }]; }) })) })),
  };
  return {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 702 }] })) })),
    financialEntries,
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

  it("executa somente distrato aprovado e preserva a trilha do contrato", async () => {
    const db = makeDb(); dbMocks.getDb.mockResolvedValue(db);
    await expect(caller().executeCancellation({ requestId: 801, executionNotes: "Conferido pelo financeiro" })).resolves.toMatchObject({ success: true, contractId: 701, cancelledInstallments: 2, cancelledCommissions: 2, financialEntries: 2 });
    expect(db.financialEntries).toEqual(expect.arrayContaining([expect.objectContaining({ type: "income", category: "Distrato · multa/retenção", amount: "120.00" }), expect.objectContaining({ type: "expense", category: "Distrato · reembolso", amount: "80.00" })]));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "contract_cancellation_request", 801, "executed", expect.stringContaining("parcelas canceladas: 2"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "contract.status.updated", aggregateId: 701, payload: expect.objectContaining({ status: "cancelled" }) }));
  });

  it("bloqueia pedido não aprovado e não registra execução", async () => {
    dbMocks.getDb.mockResolvedValue(makeDb({ requestStatus: "requested" }));
    await expect(caller().executeCancellation({ requestId: 801 })).rejects.toMatchObject({ message: "Somente distrato aprovado pode ser executado." });
    expect(dbMocks.recordAudit).not.toHaveBeenCalledWith(55, "contract_cancellation_request", 801, "executed", expect.anything());
  });

  it("bloqueia reexecução de pedido já executado", async () => {
    dbMocks.getDb.mockResolvedValue(makeDb({ requestStatus: "executed" }));
    await expect(caller().executeCancellation({ requestId: 801 })).rejects.toMatchObject({ message: "Somente distrato aprovado pode ser executado." });
  });

  it("propaga falha intermediária e não registra execução concluída", async () => {
    dbMocks.getDb.mockResolvedValue(makeDb({ failAtUpdate: 4 }));
    await expect(caller().executeCancellation({ requestId: 801 })).rejects.toThrow("rollback sentinel");
    expect(dbMocks.recordAudit).not.toHaveBeenCalledWith(55, "contract_cancellation_request", 801, "executed", expect.anything());
  });
});
