import { beforeEach, describe, expect, it, vi } from "vitest";
import { contracts, saleValidations, salesCommissions } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./revenueQualitySync", () => ({ syncRevenueQualityForContract: vi.fn(async () => ({})) }));

import { commissionsRouter } from "./routers/commissions";

function makeDb(rows: unknown[], affectedRows = 1, linked: { contract?: unknown[]; validation?: unknown[] } = {}) {
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      const result = table === salesCommissions ? rows : table === contracts ? (linked.contract ?? []) : table === saleValidations ? (linked.validation ?? []) : null;
      if (!result) throw new Error("Tabela não prevista neste teste");
      return { where: vi.fn(() => ({ limit: vi.fn(async () => result) })) };
    }),
  }));
  const sets: unknown[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((value: unknown) => { sets.push(value); return { where: vi.fn(async () => ({ affectedRows })) }; }),
  }));
  return { db: { select, update }, update, sets };
}

function caller() {
  return commissionsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

// KAN-31 V6 (decisão Lucas 2026-10-07): aprovar/pagar exige contrato com venda validada; os casos de aprovar/pagar usam o contrato 61 validado.
describe("integridade do status de comissão", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita comissão inexistente sem atualizar ou auditar", async () => {
    const fixture = makeDb([]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita corrida perdida sem auditar alteração falsa", async () => {
    const fixture = makeDb([{ contractId: 61, status: "pending" }], 0, { contract: [{ status: "active" }], validation: [{ validatedAt: new Date("2026-10-06T12:00:00Z") }] });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("atualiza comissão existente e audita uma única vez", async () => {
    const fixture = makeDb([{ contractId: 61, status: "pending" }], 1, { contract: [{ status: "active" }], validation: [{ validatedAt: new Date("2026-10-06T12:00:00Z") }] });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).resolves.toEqual({ success: true });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_commission", 901, "approved", "Comissão marcada como approved.");
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith({ eventName: "commission.status.updated", aggregateType: "sales_commission", aggregateId: 901, actorUserId: 55, payload: { status: "approved", contractId: 61 } });
  });

  it("sincroniza lifecycle e datas quando a comissão é paga", async () => {
    const fixture = makeDb([{ contractId: 61, status: "approved" }], 1, { contract: [{ status: "active" }], validation: [{ validatedAt: new Date("2026-10-06T12:00:00Z") }] });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "paid" })).resolves.toEqual({ success: true });
    expect(fixture.sets[0]).toMatchObject({ status: "paid", lifecycleStatus: "paid", paidAt: expect.any(Date), receivedAt: expect.any(Date) });
    expect((fixture.sets[0] as { paidAt: Date }).paidAt).toEqual((fixture.sets[0] as { receivedAt: Date }).receivedAt);
  });

  it("sincroniza lifecycle e data quando a comissão é cancelada", async () => {
    const fixture = makeDb([{ contractId: null, status: "approved" }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "cancelled" })).resolves.toEqual({ success: true });
    expect(fixture.sets[0]).toMatchObject({ status: "cancelled", lifecycleStatus: "cancelled", cancelledAt: expect.any(Date) });
  });

  it("torna retry do mesmo status um no-op sem repetir trilha", async () => {
    const fixture = makeDb([{ contractId: null, status: "approved" }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).resolves.toEqual({ success: true });
    expect(fixture.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it.each([
    { current: "paid" as const, next: "approved" as const },
    { current: "cancelled" as const, next: "paid" as const },
  ])("bloqueia reabertura de comissão $current para $next", async ({ current, next }) => {
    const fixture = makeDb([{ contractId: 61, status: current }], 1, { contract: [{ status: "active" }], validation: [{ validatedAt: new Date("2026-10-06T12:00:00Z") }] });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: next })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  describe("ADR-007: aprovar/pagar exige contrato de venda validada e não cancelado", () => {
    const validated = [{ validatedAt: new Date("2026-10-06T12:00:00Z") }];
    it.each(["approved", "paid"] as const)("%s: contrato sem validação => COMMISSION_REQUIRES_VALIDATED_SALE, sem update, auditoria ou evento", async next => {
      const fixture = makeDb([{ contractId: 61, status: "pending" }], 1, { contract: [{ status: "active" }], validation: [] });
      dbMocks.getDb.mockResolvedValue(fixture.db);
      await expect(caller().setStatus({ id: 901, status: next })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("COMMISSION_REQUIRES_VALIDATED_SALE") });
      expect(fixture.update).not.toHaveBeenCalled();
      expect(dbMocks.recordAudit).not.toHaveBeenCalled();
      expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
    });
    it("validação sem validatedAt (só pagamento confirmado) também recusa", async () => {
      const fixture = makeDb([{ contractId: 61, status: "pending" }], 1, { contract: [{ status: "pending_signature" }], validation: [{ validatedAt: null }] });
      dbMocks.getDb.mockResolvedValue(fixture.db);
      await expect(caller().setStatus({ id: 901, status: "approved" })).rejects.toMatchObject({ message: expect.stringContaining("COMMISSION_REQUIRES_VALIDATED_SALE") });
    });
    it("contrato cancelado, mesmo com venda que foi validada: recusa aprovar/pagar", async () => {
      for (const next of ["approved", "paid"] as const) {
        const fixture = makeDb([{ contractId: 61, status: "pending" }], 1, { contract: [{ status: "cancelled" }], validation: validated });
        dbMocks.getDb.mockResolvedValue(fixture.db);
        await expect(caller().setStatus({ id: 901, status: next })).rejects.toMatchObject({ message: expect.stringContaining("COMMISSION_REQUIRES_VALIDATED_SALE") });
        expect(fixture.update).not.toHaveBeenCalled();
      }
    });
    it("venda validada e contrato ativo: aprova e paga normalmente", async () => {
      for (const [current, next] of [["pending", "approved"], ["approved", "paid"]] as const) {
        const fixture = makeDb([{ contractId: 61, status: current }], 1, { contract: [{ status: "active" }], validation: validated });
        dbMocks.getDb.mockResolvedValue(fixture.db);
        await expect(caller().setStatus({ id: 901, status: next })).resolves.toEqual({ success: true });
      }
    });
    it("cancelar a comissão continua permitido mesmo sem venda validada (não libera dinheiro)", async () => {
      const fixture = makeDb([{ contractId: 61, status: "pending" }], 1, { contract: [{ status: "cancelled" }], validation: [] });
      dbMocks.getDb.mockResolvedValue(fixture.db);
      await expect(caller().setStatus({ id: 901, status: "cancelled" })).resolves.toEqual({ success: true });
    });
  });
});
