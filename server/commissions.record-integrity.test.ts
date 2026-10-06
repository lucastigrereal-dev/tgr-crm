import { beforeEach, describe, expect, it, vi } from "vitest";
import { contracts, opportunities, saleValidations, salesCampaigns, salesCommissions, users } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);
const syncMocks = vi.hoisted(() => ({ syncRevenueQualityForContract: vi.fn(async () => ({})) }));
vi.mock("./revenueQualitySync", () => syncMocks);

import { commissionsRouter } from "./routers/commissions";

function makeDb({ sellerExists = true, sellerEligible = true, campaignExists = true, opportunityExists = true, contractExists = true, contractStatus = "active", saleValidated = true, existingCommission, insertError }: { contractStatus?: string; saleValidated?: boolean; sellerExists?: boolean; sellerEligible?: boolean; campaignExists?: boolean; opportunityExists?: boolean; contractExists?: boolean; existingCommission?: unknown; insertError?: unknown } = {}) {
  const inserted: unknown[] = [];
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          if (table === users) return sellerExists && sellerEligible ? [{ id: 55 }] : [];
          if (table === salesCampaigns) return campaignExists ? [{ id: 10 }] : [];
          if (table === opportunities) return opportunityExists ? [{ id: 20 }] : [];
          if (table === contracts) return contractExists ? [{ id: 30, status: contractStatus }] : [];
          if (table === saleValidations) return saleValidated ? [{ validatedAt: new Date("2026-10-06T12:00:00Z") }] : [];
          if (table === salesCommissions) return existingCommission ? [existingCommission] : [];
          return [];
        }),
      })),
    })),
  }));
  const insert = vi.fn(() => ({ values: vi.fn((value: unknown) => { inserted.push(value); return { $returningId: async () => { if (insertError) throw insertError; return [{ id: 901 }]; } }; }) }));
  return { db: { select, insert }, inserted, insert };
}

function caller() {
  return commissionsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

// ADR-007: lançamento manual exige contrato de venda VALIDADA.
const baseInput = { sellerId: 55, contractId: 30, baseAmount: 1000, rate: 10, notes: "Lançamento manual" };

describe("integridade do lançamento manual de comissão", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADR-007: sem contractId a comissão manual é recusada (COMMISSION_REQUIRES_VALIDATED_SALE)", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const { contractId: _omit, ...withoutContract } = baseInput;
    await expect(caller().record(withoutContract)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("COMMISSION_REQUIRES_VALIDATED_SALE") });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("ADR-007: contrato sem venda validada (VENDEU, pendente ou só pagamento confirmado) não gera comissão manual", async () => {
    const fixture = makeDb({ saleValidated: false });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await expect(caller().record(baseInput)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("COMMISSION_REQUIRES_VALIDATED_SALE") });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("revisão KAN-31: contrato CANCELADO não recebe comissão manual, mesmo com a venda que um dia foi validada", async () => {
    const fixture = makeDb({ contractStatus: "cancelled", saleValidated: true });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    await expect(caller().record(baseInput)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("COMMISSION_REQUIRES_VALIDATED_SALE") });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("rejeita vendedor inexistente antes do insert", async () => {
    const fixture = makeDb({ sellerExists: false });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record(baseInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita comissão para usuário fora da equipe comercial antes do insert", async () => {
    const fixture = makeDb({ sellerEligible: false });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record(baseInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("rejeita referência opcional de campanha inexistente", async () => {
    const fixture = makeDb({ campaignExists: false });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record({ ...baseInput, campaignId: 10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("cria comissão válida e audita o ID persistido", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record(baseInput)).resolves.toEqual({ id: 901, amount: 100 });
    expect(fixture.inserted[0]).toMatchObject({ sellerId: 55, baseAmount: "1000.00", rate: "10.00", amount: "100.00" });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_commission", 901, "created", "Comissão de 100.00 lançada.");
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith({ eventName: "commission.created", aggregateType: "sales_commission", aggregateId: 901, actorUserId: 55, payload: { sellerId: 55, campaignId: null, opportunityId: null, contractId: 30, sourceInstallmentId: null, commissionRole: "manual", amount: 100, rate: 10 } });
  });

  it("reutiliza comissão idempotente sem repetir efeitos", async () => {
    const fixture = makeDb({ existingCommission: { id: 902, sellerId: 55, campaignId: null, opportunityId: null, contractId: 30, baseAmount: "1000.00", rate: "10.00", amount: "100.00", notes: "Lançamento manual" } });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record({ ...baseInput, idempotencyKey: "commission-key-902-unique" })).resolves.toEqual({ id: 902, amount: 100, reused: true });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("recusa chave idempotente com payload divergente", async () => {
    const fixture = makeDb({ existingCommission: { id: 902, sellerId: 55, campaignId: null, opportunityId: null, contractId: 30, baseAmount: "1000.00", rate: "10.00", amount: "100.00", notes: "Lançamento manual" } });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record({ ...baseInput, idempotencyKey: "commission-key-902-unique", rate: 20 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("trata colisão concorrente da chave como retry idempotente", async () => {
    const duplicateError = { code: "ER_DUP_ENTRY" };
    const fixture = makeDb({ insertError: duplicateError, existingCommission: { id: 903, sellerId: 55, campaignId: null, opportunityId: null, contractId: 30, baseAmount: "1000.00", rate: "10.00", amount: "100.00", notes: "Lançamento manual" } });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record({ ...baseInput, idempotencyKey: "commission-key-903-unique" })).resolves.toEqual({ id: 903, amount: 100, reused: true });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });
});

