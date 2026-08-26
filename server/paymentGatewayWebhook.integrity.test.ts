import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const paymentMocks = vi.hoisted(() => ({
  getAsaasConfig: vi.fn(() => ({ baseUrl: "https://asaas.test", apiKey: "key", webhookToken: "secret" })),
  isAsaasWebhookTokenValid: vi.fn(() => true),
  isAsaasPaymentConfirmed: vi.fn(() => true),
  isAsaasPaymentOverdue: vi.fn(() => false),
}));
const syncMocks = vi.hoisted(() => ({ syncRevenueQualityForContract: vi.fn(async () => ({})) }));
vi.mock("./db", () => dbMocks);
vi.mock("./paymentGateway", () => paymentMocks);
vi.mock("./revenueQualitySync", () => syncMocks);

import { billingRecords, installments, paymentGatewayWebhookEvents } from "../drizzle/schema";
import { processAsaasWebhook } from "./paymentGatewayWebhook";

function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(async () => rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

describe("idempotência financeira do webhook Asaas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emite payload completo quando o webhook liquida a parcela", async () => {
    const txInsert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
    const txUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })) }));
    const tx = { insert: txInsert, update: txUpdate };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([]))
        .mockReturnValueOnce(query([{ billing: { id: 301, type: "pix", status: "generated", gatewayPaymentId: "pay-91" }, installment: { id: 91, status: "open", contractId: 61, sequence: 1, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") } }]))
        .mockReturnValueOnce(query([])),
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    dbMocks.getDb.mockResolvedValue(db);

    await expect(processAsaasWebhook("secret", { id: "evt-91", event: "PAYMENT_CONFIRMED", payment: { id: "pay-91", status: "CONFIRMED", billingType: "PIX" } })).resolves.toMatchObject({ status: 200, billingRecordId: 301, installmentPaid: true });

    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith({ eventName: "installment.paid", aggregateType: "installment", aggregateId: 91, actorUserId: null, payload: { installmentId: 91, paidAmount: "1000.00", contractId: 61, sequence: 1, amount: "1000.00", source: "asaas", gatewayPaymentId: "pay-91", commissionBlocked: false } });
  });

  it("não cria segunda receita quando a parcela já foi liquidada por outro evento", async () => {
    const txInsert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
    const txUpdate = vi.fn(() => {
      const affectedRows = txUpdate.mock.calls.length === 2 ? 0 : 1;
      return { set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows })) })) };
    });
    const tx = { insert: txInsert, update: txUpdate };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([]))
        .mockReturnValueOnce(query([{
          billing: { id: 301, type: "pix", gatewayPaymentId: "pay_91" },
          installment: { id: 91, status: "open", contractId: 61, sequence: 1, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") },
        }])),
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    dbMocks.getDb.mockResolvedValue(db);

    await expect(processAsaasWebhook("secret", { id: "evt-92", event: "PAYMENT_CONFIRMED", payment: { id: "pay_91", status: "CONFIRMED", billingType: "PIX" } })).resolves.toMatchObject({
      status: 200,
      billingRecordId: 301,
      installmentPaid: false,
    });

    expect(db.select).toHaveBeenCalledTimes(2);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(dbMocks.recordAudit).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });
});

void billingRecords;
void installments;
void paymentGatewayWebhookEvents;


describe("monotonicidade de estado do webhook", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não regride cobrança paga quando chega atraso fora de ordem", async () => {
    const updated: unknown[] = [];
    const txInsert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
    const txUpdate = vi.fn(() => ({
      set: vi.fn((values: unknown) => ({ where: vi.fn(async () => { updated.push(values); return { affectedRows: 1 }; }) })),
    }));
    const tx = { insert: txInsert, update: txUpdate };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([]))
        .mockReturnValueOnce(query([{
          billing: { id: 301, type: "pix", status: "paid", gatewayPaymentId: "pay_91" },
          installment: { id: 91, status: "paid", contractId: 61, sequence: 1, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") },
        }])),
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    dbMocks.getDb.mockResolvedValue(db);
    paymentMocks.isAsaasPaymentConfirmed.mockReturnValue(false);
    paymentMocks.isAsaasPaymentOverdue.mockReturnValue(true);

    await expect(processAsaasWebhook("secret", { id: "evt-late-95", event: "PAYMENT_OVERDUE", payment: { id: "pay_91", status: "OVERDUE" } })).resolves.toMatchObject({
      status: 200,
      billingRecordId: 301,
      installmentPaid: false,
    });

    expect(updated).toEqual([{ gatewayStatus: "OVERDUE" }]);
    expect(updated).not.toContainEqual(expect.objectContaining({ status: "expired" }));
    expect(dbMocks.recordAudit).toHaveBeenCalledTimes(1);
  });
});



describe("deduplicação concorrente de eventos", () => {
  beforeEach(() => vi.clearAllMocks());

  it("responde duplicado quando outro worker vence o insert único do evento", async () => {
    const duplicateError = { code: "ER_DUP_ENTRY", errno: 1062 };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([]))
        .mockReturnValueOnce(query([])),
      transaction: vi.fn(async (callback: (transaction: { insert: ReturnType<typeof vi.fn> }) => Promise<unknown>) => callback({
        insert: vi.fn(() => ({ values: vi.fn(async () => { throw duplicateError; }) })),
      })),
    };
    dbMocks.getDb.mockResolvedValue(db);

    await expect(processAsaasWebhook("secret", { id: "evt-race-93", event: "PAYMENT_CONFIRMED", payment: { id: "pay-unlinked", status: "CONFIRMED" } })).resolves.toEqual({
      status: 200,
      duplicate: true,
      message: "Evento já processado.",
    });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});


describe("isolamento de erros de integridade do webhook", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não transforma violação referencial em resposta de evento duplicado", async () => {
    const integrityError = { code: "ER_NO_REFERENCED_ROW_2", sqlState: "23000" };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([]))
        .mockReturnValueOnce(query([])),
      transaction: vi.fn(async (callback: (transaction: { insert: ReturnType<typeof vi.fn> }) => Promise<unknown>) => callback({
        insert: vi.fn(() => ({ values: vi.fn(async () => { throw integrityError; }) })),
      })),
    };
    dbMocks.getDb.mockResolvedValue(db);

    await expect(processAsaasWebhook("secret", { id: "evt-integrity-94", event: "PAYMENT_CONFIRMED", payment: { id: "pay-unlinked", status: "CONFIRMED" } })).rejects.toThrow();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});
