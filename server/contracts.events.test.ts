import { beforeEach, describe, expect, it, vi } from "vitest";
import { contractCancellationRequests, contracts, customers, installments, proposals, revenueQualityLedger, salesCommissions, unitMaintenanceBlocks, users } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const storageMocks = vi.hoisted(() => ({ storagePut: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./storage", () => storageMocks);

import { contractsRouter } from "./routers/contracts";

function makeDb(options: { requestStatus?: "requested" | "approved" | "rejected" | "executed" | "cancelled"; failAtUpdate?: number; contractExists?: boolean; statusUpdateAffectedRows?: number } = {}) {
  let selectCall = 0;
  let contractSelectCall = 0;
  let ledgerSelectCall = 0;
  let updateCall = 0;
  const financialEntries: Array<{ type: string; category: string; amount: string }> = [];
  const rows = (value: unknown[]) => Object.assign(value, { limit: () => Object.assign(Promise.resolve(value), { for: async () => value }) });
  const ledgerRows = (value: unknown[]) => {
    const chain = {
      where: vi.fn(() => chain),
      limit: async () => value,
      orderBy: async () => value,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(value).then(resolve, reject),
    };
    return chain;
  };
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
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => options.statusUpdateAffectedRows === undefined ? undefined : { affectedRows: options.statusUpdateAffectedRows }) })) })),
    select: vi.fn(() => ({ from: vi.fn((table: unknown) => {
      if (table === contracts) {
        const exists = contractSelectCall++ === 0 ? options.contractExists !== false : true;
        return ledgerRows(exists ? [{ id: 701, totalAmount: "12000.00", status: "active" }] : []);
      }
      if (table === customers) return ledgerRows([{ id: 11 }]);
      if (table === users) return ledgerRows([{ id: 55 }]);
      if (table === proposals) return ledgerRows([]);
      const data = [
        [{ id: 701, totalAmount: "12000.00", status: "cancelled" }],
        [{ id: 71, sequence: 1, amount: "1000.00", status: "paid" }],
        [{ id: 91, amount: "120.00", status: "cancelled", lifecycleStatus: "cancelled", sourceInstallmentId: 71 }],
        [{ id: 801, status: "executed", createdAt: new Date() }],
      ][ledgerSelectCall++] ?? [];
      return ledgerRows(data);
    }) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ $returningId: async () => [{ id: 702 }], onDuplicateKeyUpdate: async () => undefined })) })),
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
    dbMocks.getDb.mockResolvedValue(makeDb({ contractExists: false }));
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

  it("rejeita atualização de status que perdeu a corrida", async () => {
    dbMocks.getDb.mockResolvedValue(makeDb({ statusUpdateAffectedRows: 0 }));
    await expect(caller().updateStatus({ id: 701, status: "cancelled", cancellationReason: "Solicitação documentada" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMocks.recordAudit).not.toHaveBeenCalledWith(55, "contract", 701, "status_updated", expect.any(String));
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventName: "contract.status.updated", aggregateId: 701 }));

  });

  it("normaliza falha detalhada do storage sem auditar documento falso", async () => {
    storageMocks.storagePut.mockRejectedValueOnce(new Error("payload remoto secreto"));
    dbMocks.getDb.mockResolvedValue(makeDb());

    await expect(caller().uploadDocument({ contractId: 701, category: "Contrato", filename: "contrato.pdf", contentType: "application/pdf", signed: false, base64: "data:application/pdf;base64,MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível armazenar o documento do contrato." });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita upload de documento quando o contrato não existe antes do storage", async () => {
    dbMocks.getDb.mockResolvedValue(makeDb({ contractExists: false }));
    await expect(caller().uploadDocument({ contractId: 999, category: "Contrato", filename: "contrato.pdf", contentType: "application/pdf", signed: false, base64: "data:application/pdf;base64,MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(storageMocks.storagePut).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
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
