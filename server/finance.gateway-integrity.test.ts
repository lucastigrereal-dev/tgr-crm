import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const gatewayMocks = vi.hoisted(() => ({
  getAsaasConfig: vi.fn(() => ({ baseUrl: "https://asaas.test", apiKey: "key", webhookToken: "secret" })),
  billingExternalReference: vi.fn((installmentId: number) => `TGR-CRM-INSTALLMENT-${installmentId}`),
  asaasBillingType: vi.fn((type: "pix" | "boleto") => type === "pix" ? "PIX" : "BOLETO"),
  createAsaasCustomer: vi.fn(async () => ({ id: "cus-7" })),
  createAsaasPayment: vi.fn(async () => ({ id: "pay-91", status: "PENDING", invoiceUrl: "https://invoice.test", bankSlipUrl: null })),
  findAsaasPaymentsByReference: vi.fn(async () => ({ data: [] })),
  getAsaasIdentificationField: vi.fn(async () => ({ identificationField: "" })),
  getAsaasPixQrCode: vi.fn(async () => ({ payload: "pix-payload", encodedImage: "" })),
}));
vi.mock("./db", () => dbMocks);
vi.mock("./paymentGateway", () => gatewayMocks);

import { billingRecords, installments, paymentGatewayCustomers } from "../drizzle/schema";
import { financeRouter } from "./routers/finance";

function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    for: vi.fn(async () => rows),
    then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

function makeDb() {
  const billingState: unknown[] = [];
  const gatewayCustomerState: unknown[] = [];
  const inserted: unknown[] = [];
  const installment = { id: 91, contractId: 61, sequence: 1, status: "open", amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") };
  const tx = {
    select: vi.fn(() => ({ from: (table: unknown) => {
      if (table === installments) return query([{ installment, contract: { number: "CTR-61" }, customer: { id: 7, fullName: "Ana Tigre", documentNumber: "12345678901", email: null, phone: null } }]);
      if (table === billingRecords) return query(billingState);
      if (table === paymentGatewayCustomers) return query(gatewayCustomerState);
      return query([]);
    } })),
    insert: vi.fn(() => ({ values: vi.fn((value: unknown) => {
      inserted.push(value);
      return {
        onDuplicateKeyUpdate: vi.fn(async () => { gatewayCustomerState.push({ gatewayCustomerId: "cus-7" }); }),
        $returningId: async () => { billingState.push({ billing: { id: 901, gatewayPaymentId: "pay-91" } }); return [{ id: 901 }]; },
      };
    }) })),
  };
  const db = { transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
  return { db, inserted };
}

describe("idempotência de emissão Asaas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reutiliza a cobrança persistida e não chama o gateway duas vezes", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.issueGatewayBilling({ installmentId: 91, type: "pix" })).resolves.toMatchObject({ id: 901, gatewayPaymentId: "pay-91", reused: false });
    await expect(caller.issueGatewayBilling({ installmentId: 91, type: "pix" })).resolves.toEqual({ id: 901, gatewayPaymentId: "pay-91", reused: true });

    expect(gatewayMocks.createAsaasCustomer).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.createAsaasPayment).toHaveBeenCalledTimes(1);
    expect(fixture.inserted.filter(value => typeof value === "object" && value !== null && "gatewayPaymentId" in value)).toHaveLength(1);
    expect(dbMocks.recordAudit).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledTimes(1);
  });
});

