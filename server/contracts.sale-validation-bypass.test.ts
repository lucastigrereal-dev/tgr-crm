import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-007 (V6): nenhuma rota além de saleValidation.validateSale ativa contrato; `signed` no upload só vale para quem assina.
const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const storageMocks = vi.hoisted(() => ({ storagePut: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./storage", () => storageMocks);
vi.mock("./revenueQualitySync", () => ({ syncRevenueQualityForContract: vi.fn() }));

import { contractsRouter } from "./routers/contracts";

function makeDb(currentStatus: string | null, extra: Record<string, unknown> = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => (currentStatus ? [{ id: 701, status: currentStatus, ...extra }] : [])) })) })) }));
  const update = vi.fn(() => ({ set: vi.fn((values: Record<string, unknown>) => { updates.push(values); return { where: vi.fn(async () => [{ affectedRows: 1 }]) }; }) }));
  const insert = vi.fn(() => ({ values: vi.fn((values: Record<string, unknown>) => { inserted.push(values); return { $returningId: async () => [{ id: 702 }] }; }) }));
  return { db: { select, update, insert, transaction: vi.fn() }, inserted, updates };
}
const caller = (role: "admin" | "seller" = "admin") => contractsRouter.createCaller({ user: { id: 55, role } } as never);
const upload = { contractId: 701, category: "Contrato assinado", filename: "contrato.pdf", contentType: "application/pdf", base64: "data:application/pdf;base64,MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" };

describe("bypasses de ativação fechados (ADR-007)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.storagePut.mockResolvedValue({ key: "contracts/701/contrato.pdf", url: "https://storage.example/contrato.pdf" });
  });

  it("create com status active é recusado até para admin, sem inserir nem emitir evento", async () => {
    const fixture = makeDb(null);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await expect(caller().create({ number: "TS-ACT-1", customerId: 11, status: "active", totalAmount: 1000, firstDueDate: "2026-11-10", installmentCount: 1 }))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("SALE_VALIDATION_REQUIRED") });
    expect(fixture.db.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it.each(["draft", "pending_signature", "active"])("updateStatus %s -> active é recusado até para admin (direciona à validação final)", async status => {
    const fixture = makeDb(status);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await expect(caller().updateStatus({ id: 701, status: "active" })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("SALE_VALIDATION_REQUIRED") });
    expect(fixture.updates).toEqual([]);
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("updateStatus active por seller continua FORBIDDEN", async () => {
    dbMocks.getDb.mockResolvedValue(makeDb("pending_signature").db);
    await expect(caller("seller").updateStatus({ id: 701, status: "active" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(["overdue", "closed", "cancelled"] as const)("Red Team P0-1: create com status %s é recusado (só rascunho/aguardando assinatura), sem inserir", async status => {
    for (const role of ["admin", "seller"] as const) {
      const fixture = makeDb(null);
      dbMocks.getDb.mockResolvedValue(fixture.db);
      await expect(caller(role).create({ number: "TS-ODUE-1", customerId: 11, status, totalAmount: 1000, firstDueDate: "2026-11-10", installmentCount: 1 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(fixture.db.insert).not.toHaveBeenCalled();
    }
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("Red Team P0-1: overdue -> active de contrato que nunca foi ativado (sem activatedAt) é recusado, sem gravar nem emitir", async () => {
    const fixture = makeDb("overdue", { activatedAt: null });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await expect(caller().updateStatus({ id: 701, status: "active" })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("SALE_VALIDATION_REQUIRED") });
    expect(fixture.updates).toEqual([]);
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("regularização overdue -> active segue permitida para contrato que já foi ativado (não é nova venda)", async () => {
    const fixture = makeDb("overdue", { activatedAt: new Date("2026-10-06T12:00:00Z") });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await expect(caller().updateStatus({ id: 701, status: "active" })).resolves.toEqual({ success: true });
  });

  it("overdue/closed continuam funcionando como antes", async () => {
    const fixture = makeDb("active");
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await expect(caller().updateStatus({ id: 701, status: "overdue" })).resolves.toEqual({ success: true });
  });

  it("uploadDocument: signed:true de seller é ignorado (grava signed:false)", async () => {
    const fixture = makeDb("pending_signature");
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await caller("seller").uploadDocument({ ...upload, signed: true });
    expect(fixture.inserted[0]).toMatchObject({ signed: false, storageKey: "contracts/701/contrato.pdf" });
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "contract.document.uploaded", payload: expect.objectContaining({ signed: false }) }));
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventName: "contract.document.signed" }));
  });

  it("uploadDocument: admin (document.sign) pode gravar documento assinado armazenado", async () => {
    const fixture = makeDb("pending_signature");
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await caller("admin").uploadDocument({ ...upload, signed: true });
    expect(fixture.inserted[0]).toMatchObject({ signed: true, storageKey: "contracts/701/contrato.pdf" });
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "contract.document.signed", aggregateId: 702, payload: { contractId: 701 } }));
  });

  it("uploadDocument sem a flag segue signed:false", async () => {
    const fixture = makeDb("pending_signature");
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await caller("admin").uploadDocument(upload);
    expect(fixture.inserted[0]).toMatchObject({ signed: false });
  });
});
