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

import { billingRecords, customers, installments, paymentGatewayCustomers } from "../drizzle/schema";
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

function makeDb(existingBillingType?: "pix" | "boleto", failBillingPersist = false, installmentStatus: "open" | "overdue" | "paid" | "cancelled" | "renegotiated" = "open") {
  const billingState: unknown[] = existingBillingType ? [{ billing: { id: 902, gatewayPaymentId: "pay-existing", type: existingBillingType, status: "generated" } }] : [];
  const gatewayCustomerState: unknown[] = [];
  const inserted: unknown[] = [];
  const installment = { id: 91, contractId: 61, sequence: 1, status: installmentStatus, amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z") };
  const tx = {
    select: vi.fn(() => ({ from: (table: unknown) => {
      if (table === installments) return query([{ installment, contract: { number: "CTR-61" }, customer: { id: 7, fullName: "Ana Tigre", documentNumber: "12345678901", email: null, phone: null } }]);
      if (table === billingRecords) return query(billingState);
      if (table === paymentGatewayCustomers) return query(gatewayCustomerState);
      if (table === customers) return query([{ id: 7 }]);
      return query([]);
    } })),
    insert: vi.fn(() => ({ values: vi.fn((value: unknown) => {
      inserted.push(value);
      return {
        onDuplicateKeyUpdate: vi.fn(async () => { gatewayCustomerState.push({ gatewayCustomerId: "cus-7" }); }),
        $returningId: async () => { if (failBillingPersist && typeof value === "object" && value !== null && "gatewayPaymentId" in value) throw new Error("database persist sentinel"); billingState.push({ billing: { id: 901, gatewayPaymentId: "pay-91", type: "pix", status: "generated" } }); return [{ id: 901 }]; },
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
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "financial.billing.created", aggregateType: "billing_record", aggregateId: 901 }));
  });
});



describe("isolamento de erro do gateway", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bloqueia emissão Asaas para parcela renegociada", async () => {
    const fixture = makeDb(undefined, false, "renegotiated");
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.issueGatewayBilling({ installmentId: 91, type: "pix" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(gatewayMocks.createAsaasCustomer).not.toHaveBeenCalled();
    expect(gatewayMocks.createAsaasPayment).not.toHaveBeenCalled();
    expect(fixture.inserted).toHaveLength(0);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("recusa trocar o tipo de uma cobrança Asaas já existente", async () => {
    const fixture = makeDb("pix");
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.issueGatewayBilling({ installmentId: 91, type: "boleto" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Já existe uma cobrança Asaas do tipo pix para esta parcela.",
    });
    expect(gatewayMocks.createAsaasPayment).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("normaliza falha de persistência local sem classificá-la como gateway", async () => {
    const fixture = makeDb(undefined, true);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.issueGatewayBilling({ installmentId: 91, type: "pix" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "A cobrança foi processada, mas não foi possível confirmar o estado no CRM." });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("não vaza payload remoto nem audita falha de emissão", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    gatewayMocks.createAsaasPayment.mockRejectedValueOnce(new Error("Asaas: documento inválido com dados internos"));
    const caller = financeRouter.createCaller({ user: { id: 71, role: "finance" } } as never);

    await expect(caller.issueGatewayBilling({ installmentId: 91, type: "pix" })).rejects.toMatchObject({ code: "BAD_GATEWAY", message: "O gateway de cobrança não respondeu corretamente. Tente novamente." });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});
