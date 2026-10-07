import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-007 (V6): o webhook do gateway só lança comissão automática para contrato de venda VALIDADA.
const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const paymentMocks = vi.hoisted(() => ({
  getAsaasConfig: vi.fn(() => ({ baseUrl: "https://asaas.test", apiKey: "key", webhookToken: "secret" })),
  isAsaasWebhookTokenValid: vi.fn(() => true),
  isAsaasPaymentConfirmed: vi.fn(() => true),
  isAsaasPaymentOverdue: vi.fn(() => false),
}));
vi.mock("./db", () => dbMocks);
vi.mock("./paymentGateway", () => paymentMocks);
vi.mock("./revenueQualitySync", () => ({ syncRevenueQualityForContract: vi.fn(async () => ({})) }));

import { salesCommissions } from "../drizzle/schema";
import { processAsaasWebhook } from "./paymentGatewayWebhook";

function query(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, ReturnType<typeof vi.fn>>;
  for (const key of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "for"]) promise[key] = vi.fn(() => promise);
  return promise;
}
const policy = JSON.stringify({ linerRate: 0.02, closerRate: 0.03, ftbRate: 0.04, cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt" });
const billingRow = { billing: { id: 301, type: "pix", status: "generated", gatewayPaymentId: "pay-91" }, installment: { id: 91, status: "open", contractId: 61, sequence: 2, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") } };

function run(validation: Array<{ validatedAt: Date | null }>, commissionPolicy = policy) {
  const inserted: Array<{ table: unknown }> = [];
  const tx = {
    insert: vi.fn((table: unknown) => ({ values: vi.fn((values: unknown) => { inserted.push({ table }); return Object.assign(Promise.resolve(undefined), { $returningId: async () => (Array.isArray(values) ? values : [values]).map((_, i) => ({ id: 700 + i })) }); }) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })) })),
    select: vi.fn()
      .mockReturnValueOnce(query([{ id: 61, status: "active" }]))
      .mockReturnValueOnce(query([billingRow]))
      .mockReturnValueOnce(query([{ contract: { id: 61, customerId: 5, status: "active", totalAmount: "10000.00" }, proposal: { id: 41, downPaymentAmount: "1000.00" }, opportunity: { id: 51 }, capture: { id: 100, resortId: 2, campaignId: 8, linerId: 10, closerId: 11 } }]))
      .mockReturnValueOnce(query([{ commissionPolicy: commissionPolicy }]))
      .mockReturnValueOnce(query(validation))
      .mockReturnValue(query([])),
  };
  const db = {
    select: vi.fn().mockReturnValueOnce(query([])).mockReturnValueOnce(query([billingRow])),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  dbMocks.getDb.mockResolvedValue(db);
  return { inserted, result: processAsaasWebhook("secret", { id: `evt-${Math.random()}`, event: "PAYMENT_CONFIRMED", payment: { id: "pay-91", status: "CONFIRMED", billingType: "PIX" } }) };
}

describe("webhook Asaas: comissão automática exige venda validada", () => {
  beforeEach(() => vi.clearAllMocks());

  it("contrato active sem validação final: parcela liquida, comissão bloqueada e auditada", async () => {
    const { inserted, result } = run([]);
    await expect(result).resolves.toMatchObject({ status: 200, installmentPaid: true });
    expect(inserted.filter(entry => entry.table === salesCommissions)).toHaveLength(0);
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.automatic.blocked", payload: expect.objectContaining({ source: "asaas" }) }));
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.created" }));
  });

  it("motivo do bloqueio é a causa real (venda não validada x política incompleta)", async () => {
    await run([]).result;
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.automatic.blocked", payload: expect.objectContaining({ reason: "sale_not_validated", source: "asaas" }) }));
    vi.clearAllMocks();
    await run([{ validatedAt: new Date("2026-10-06T12:00:00Z") }], JSON.stringify({ linerRate: 0.02 })).result;
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.automatic.blocked", payload: expect.objectContaining({ reason: "incomplete_project_policy", source: "asaas" }) }));
  });

  it("venda validada: comissão é lançada", async () => {
    const { inserted, result } = run([{ validatedAt: new Date("2026-10-06T12:00:00Z") }]);
    await expect(result).resolves.toMatchObject({ status: 200, installmentPaid: true });
    expect(inserted.filter(entry => entry.table === salesCommissions).length).toBeGreaterThan(0);
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.created" }));
  });

  it("ADR-010: portão aberto com todos os papéis a 0% registra commission.automatic.skipped (zero_rate) em vez de silêncio", async () => {
    const zeroRatePolicy = JSON.stringify({ cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt" });
    const { inserted, result } = run([{ validatedAt: new Date("2026-10-06T12:00:00Z") }], zeroRatePolicy);
    await expect(result).resolves.toMatchObject({ status: 200, installmentPaid: true });
    expect(inserted.filter(entry => entry.table === salesCommissions)).toHaveLength(0);
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.automatic.skipped", aggregateId: 91, idempotencyKey: "commission-skipped:91:zero_rate", payload: { contractId: 61, installmentId: 91, resortId: 2, reason: "zero_rate", roles: ["liner", "closer"], source: "asaas" } }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(null, "installment", 91, "commission_skipped", expect.any(String), { idempotencyKey: "commission-skipped:91:zero_rate" });
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.created" }));
  });

  it("com taxa > 0 não há evento de salto", async () => {
    await run([{ validatedAt: new Date("2026-10-06T12:00:00Z") }]).result;
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.automatic.skipped" }));
  });
});
