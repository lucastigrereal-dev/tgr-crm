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

import { auditLogs, billingRecords, domainEvents, installments, paymentGatewayIssueIntents, paymentGatewayWebhookEvents } from "../drizzle/schema";
import { processAsaasWebhook } from "./paymentGatewayWebhook";

function query(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, ReturnType<typeof vi.fn>>;
  promise.from = vi.fn(() => promise);
  promise.innerJoin = vi.fn(() => promise);
  promise.leftJoin = vi.fn(() => promise);
  promise.where = vi.fn(() => promise);
  promise.orderBy = vi.fn(() => promise);
  promise.limit = vi.fn(() => promise);
  promise.for = vi.fn(() => promise);
  return promise;
}

// Issue #43: auditoria e eventos do webhook nascem na transação; o mock guarda cada tx.insert para a prova.
function capturingInsert() {
  const rows: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const insert = vi.fn((table: unknown) => ({ values: vi.fn((values: Record<string, unknown>) => { rows.push({ table, values }); return Object.assign(Promise.resolve(undefined), { onDuplicateKeyUpdate: async () => undefined }); }) }));
  return { rows, insert };
}

describe("idempotência financeira do webhook Asaas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emite payload completo quando o webhook liquida a parcela", async () => {
    const { rows, insert: txInsert } = capturingInsert();
    const txUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })) }));
    const lockedBillingQuery = query([{ billing: { id: 301, type: "pix", status: "generated", gatewayPaymentId: "pay-91" }, installment: { id: 91, status: "open", contractId: 61, sequence: 1, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") } }]);
    const tx = { insert: txInsert, update: txUpdate, select: vi.fn(() => lockedBillingQuery) };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([]))
        .mockReturnValueOnce(query([{ billing: { id: 301, type: "pix", status: "generated", gatewayPaymentId: "pay-91" }, installment: { id: 91, status: "open", contractId: 61, sequence: 1, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") } }])),
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    dbMocks.getDb.mockResolvedValue(db);

    await expect(processAsaasWebhook("secret", { id: "evt-91", event: "PAYMENT_CONFIRMED", payment: { id: "pay-91", status: "CONFIRMED", billingType: "PIX" } })).resolves.toMatchObject({ status: 200, billingRecordId: 301, installmentPaid: true });

    const paidEvents = rows.filter(row => row.table === domainEvents && row.values.eventName === "installment.paid");
    expect(paidEvents).toHaveLength(1);
    expect(paidEvents[0].values).toMatchObject({ aggregateType: "installment", aggregateId: "91", actorUserId: null, idempotencyKey: "installment-paid:91" });
    expect(JSON.parse(paidEvents[0].values.payload as string)).toEqual({ installmentId: 91, paidAmount: "1000.00", contractId: 61, sequence: 1, amount: "1000.00", source: "asaas", gatewayPaymentId: "pay-91", commissionBlocked: false });
    expect(rows.filter(row => row.table === auditLogs).map(row => row.values.action)).toEqual(["gateway_payment_confirmed"]);
    // Nada de fato financeiro depois do commit.
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(lockedBillingQuery.for).toHaveBeenCalledWith("update");
    expect(lockedBillingQuery.orderBy).toHaveBeenCalled();
  });

  it("confirmação atrasada de cobrança cancelada não baixa nada, mas vai para revisão manual (auditoria + intenção)", async () => {
    paymentMocks.isAsaasPaymentConfirmed.mockReturnValue(true);
    paymentMocks.isAsaasPaymentOverdue.mockReturnValue(false);
    const txInsert = vi.fn(() => ({ values: vi.fn(() => Object.assign(Promise.resolve(undefined), { onDuplicateKeyUpdate: async () => undefined })) }));
    const txUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })) }));
    const tx = { insert: txInsert, update: txUpdate, select: vi.fn(() => query([{ billing: { id: 302, type: "pix", status: "cancelled", gatewayPaymentId: "pay-92" }, installment: { id: 92, status: "cancelled", contractId: 62, sequence: 1, amount: "500.00", dueDate: new Date("2026-09-11T12:00:00Z") } }])) };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([]))
        .mockReturnValueOnce(query([{ billing: { id: 302, type: "pix", status: "cancelled", gatewayPaymentId: "pay-92" }, installment: { id: 92, status: "cancelled", contractId: 62, sequence: 1, amount: "500.00", dueDate: new Date("2026-09-11T12:00:00Z") } }])),
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    dbMocks.getDb.mockResolvedValue(db);

    await expect(processAsaasWebhook("secret", { id: "evt-92-cancelled", event: "PAYMENT_CONFIRMED", payment: { id: "pay-92", status: "CONFIRMED" } })).resolves.toMatchObject({ status: 200, billingRecordId: 302, installmentPaid: false, needsReview: true });

    // Só a intenção de emissão é tocada (revisão manual); cobrança e parcela não mudam.
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledWith(paymentGatewayIssueIntents);
    // Registro do evento recebido + auditoria do recebimento + auditoria de revisão, todos na transação; nenhum fato financeiro.
    expect(txInsert).toHaveBeenCalledTimes(3);
    expect(txInsert).toHaveBeenNthCalledWith(1, paymentGatewayWebhookEvents);
    expect(txInsert).toHaveBeenNthCalledWith(2, auditLogs);
    expect(txInsert).toHaveBeenNthCalledWith(3, auditLogs);
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("não cria segunda receita quando a parcela já foi liquidada por outro evento", async () => {
    const txInsert = vi.fn(() => ({ values: vi.fn(() => Object.assign(Promise.resolve(undefined), { onDuplicateKeyUpdate: async () => undefined })) }));
    const txUpdate = vi.fn(() => {
      const affectedRows = txUpdate.mock.calls.length === 2 ? 0 : 1;
      return { set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows })) })) };
    });
    const tx = { insert: txInsert, update: txUpdate, select: vi.fn(() => query([{ billing: { id: 301, type: "pix", status: "generated", gatewayPaymentId: "pay_91" }, installment: { id: 91, status: "open", contractId: 61, sequence: 1, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") } }])) };
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
      needsReview: true,
    });

    expect(db.select).toHaveBeenCalledTimes(2);
    expect(txInsert).toHaveBeenCalledTimes(3); // evento + auditoria + auditoria de revisão (pagamento em duplicidade)
    expect(txInsert).toHaveBeenNthCalledWith(2, auditLogs);
    expect(txUpdate).toHaveBeenCalledTimes(3); // cobrança, parcela (0 linhas) e intenção em revisão
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
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
    const tx = { insert: txInsert, update: txUpdate, select: vi.fn(() => query([{ billing: { id: 301, type: "pix", status: "paid", gatewayPaymentId: "pay_91" }, installment: { id: 91, status: "paid", contractId: 61, sequence: 1, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") } }])) };
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
    expect(txInsert).toHaveBeenCalledWith(auditLogs);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
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
