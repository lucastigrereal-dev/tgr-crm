import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, billingRecords, contracts, customers, domainEvents, installments, paymentGatewayIssueIntents, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { runTriggerDdl } from "./mysqlTestDdl";

// CRM-A10 em MySQL REAL: cobrança criada no Asaas e perdida pelo CRM (a transação local falha depois da chamada remota) é recuperada
// de forma durável. O gateway é SEMPRE simulado em memória (nenhuma credencial real, nenhuma chamada de rede). Dados sintéticos.
type FakePayment = { id: string; status: string; billingType: string; externalReference: string; value: number; invoiceUrl: string; bankSlipUrl: string | null };
const remote = vi.hoisted(() => ({ payments: [] as FakePayment[], failCreate: false, createCalls: 0 }));
vi.mock("./paymentGateway", async importOriginal => {
  const real = await importOriginal<typeof import("./paymentGateway")>();
  return {
    ...real,
    createAsaasCustomer: async () => ({ id: "cus-sintetico" }),
    findAsaasPaymentsByReference: async (_c: unknown, reference: string) => ({ data: remote.payments.filter(payment => payment.externalReference === reference) }),
    createAsaasPayment: async (_c: unknown, input: { billingType: string; value: number; externalReference: string }) => {
      remote.createCalls += 1;
      if (remote.failCreate) throw new Error("gateway indisponível (simulado)");
      const payment: FakePayment = { id: `pay_sint_${remote.payments.length + 1}_${input.externalReference}`, status: "PENDING", billingType: input.billingType, externalReference: input.externalReference, value: input.value, invoiceUrl: "https://asaas.invalid/i/1", bankSlipUrl: null };
      remote.payments.push(payment);
      return payment;
    },
    getAsaasIdentificationField: async () => ({ identificationField: "00190000090000000000000000000000000000000000000" }),
    getAsaasPixQrCode: async () => ({ payload: "pix-sintetico", encodedImage: "" }),
  };
});

const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("CRM-A10: cobrança Asaas órfã é recuperada de forma durável (MySQL real, gateway simulado)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let financeRouter: typeof import("./routers/finance")["financeRouter"];
  let recover: typeof import("./gatewayIssueRecovery")["recoverOrphanGatewayBillings"];
  let config: import("./paymentGateway").AsaasConfig;
  let adminId: number;
  const previousEnv = { ...process.env };
  const triggers: string[] = [];

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    process.env.ASAAS_API_KEY = "sintetico-nao-real";
    process.env.ASAAS_API_URL = "https://asaas.invalid";
    process.env.ASAAS_WEBHOOK_TOKEN = "token-sintetico-a10";
    ({ financeRouter } = await import("./routers/finance"));
    ({ recoverOrphanGatewayBillings: recover } = await import("./gatewayIssueRecovery"));
    config = { apiKey: "sintetico-nao-real", baseUrl: "https://asaas.invalid", webhookToken: "token-sintetico-a10" };
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `a10-admin-${runId}`, name: "Financeiro A10", role: "admin" }).$returningId();
  });
  afterEach(async () => { remote.failCreate = false; for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); });
  afterAll(async () => { for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); process.env = previousEnv; await pool?.end(); });

  let docSeq = Number(`${Date.now()}`.slice(-8)) * 100;
  async function seedInstallment(label: string) {
    const [customer] = await db.insert(customers).values({ fullName: `Cliente A10 ${label} ${runId}`, documentNumber: String(10_000_000_000 + (docSeq += 1)), status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `A10-${label}-${runId}`, customerId: customer.id, status: "active", totalAmount: "3000.00" }).$returningId();
    const [inst] = await db.insert(installments).values({ contractId: contract.id, sequence: 1, dueDate: new Date("2026-12-10T12:00:00Z"), amount: "1500.00", status: "open", paidAmount: "0.00" }).$returningId();
    return inst.id;
  }
  async function failBillingEvent(installmentId: number) {
    const name = `a10_fail_billing_${runId}_${installmentId}`;
    await runTriggerDdl(pool, `CREATE TRIGGER \`${name}\` BEFORE INSERT ON domain_events FOR EACH ROW BEGIN IF NEW.eventName = 'financial.billing.created' AND NEW.payload LIKE '%"installmentId":${installmentId},%' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'falha injetada: financial.billing.created'; END IF; END`);
    triggers.push(name);
    return name;
  }
  const dropTrigger = async (name: string) => { await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); triggers.splice(triggers.indexOf(name), 1); };
  const caller = () => financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);
  const localBillings = (installmentId: number) => db.select().from(billingRecords).where(eq(billingRecords.installmentId, installmentId));
  const intentOf = async (installmentId: number) => (await db.select().from(paymentGatewayIssueIntents).where(eq(paymentGatewayIssueIntents.installmentId, installmentId)))[0];

  it("emissão normal grava a intenção e a marca como registrada; a recuperação não toca nela", async () => {
    const installmentId = await seedInstallment("normal");
    await expect(caller().issueGatewayBilling({ installmentId, type: "pix" })).resolves.toMatchObject({ reused: false });
    expect((await intentOf(installmentId))?.status).toBe("recorded");
    expect(await localBillings(installmentId)).toHaveLength(1);
    const before = remote.payments.length;
    await recover(db as never, config, { minAgeMs: 0, limit: 500 });
    expect(remote.payments).toHaveLength(before);
    expect(await localBillings(installmentId)).toHaveLength(1);
  });

  it("ÓRFÃ: o Asaas cria a cobrança, a transação local falha (evento) e nada fica no CRM; a intenção sobrevive e a recuperação reconstrói tudo, uma vez", async () => {
    const installmentId = await seedInstallment("orfa");
    const trigger = await failBillingEvent(installmentId);
    await expect(caller().issueGatewayBilling({ installmentId, type: "boleto" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    const orphan = remote.payments.find(payment => payment.externalReference === `TGR-CRM-INSTALLMENT-${installmentId}`);
    expect(orphan).toBeDefined();
    expect(await localBillings(installmentId)).toHaveLength(0);
    expect(await intentOf(installmentId)).toMatchObject({ status: "pending", attempts: 0 });

    // recuperação enquanto o banco ainda recusa o evento: falha registrada, nada local, intenção continua pendente
    const failed = await recover(db as never, config, { minAgeMs: 0, limit: 500 });
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(await localBillings(installmentId)).toHaveLength(0);
    expect(await intentOf(installmentId)).toMatchObject({ status: "pending", attempts: 1 });

    await dropTrigger(trigger);
    // intenção recente (antes da idade mínima) não é tocada: protege emissão em andamento
    const tooYoung = await recover(db as never, config, { minAgeMs: 3_600_000, limit: 500 });
    expect(tooYoung.scanned).toBe(0);
    expect(await localBillings(installmentId)).toHaveLength(0);

    const done = await recover(db as never, config, { minAgeMs: 0, limit: 500 });
    expect(done.recovered).toBeGreaterThanOrEqual(1);
    const rows = await localBillings(installmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gatewayProvider: "asaas", gatewayPaymentId: orphan!.id, type: "boleto", status: "generated", amount: "1500.00", digitableLine: "00190000090000000000000000000000000000000000000" });
    expect(await intentOf(installmentId)).toMatchObject({ status: "recovered", gatewayPaymentId: orphan!.id });
    const events = (await db.select().from(domainEvents).where(eq(domainEvents.eventName, "financial.billing.created" as never))).filter(event => String(event.payload).includes(`"installmentId":${installmentId},`));
    expect(events).toHaveLength(1);
    expect(String(events[0]!.payload)).toContain('"recovered":true');
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "billing_record"), eq(auditLogs.entityId, String(rows[0]!.id)), eq(auditLogs.action, "gateway_recovered")));
    expect(audits).toHaveLength(1);

    // repetir a recuperação é no-op; repetir a emissão reaproveita a cobrança sem criar outra no gateway
    expect((await recover(db as never, config, { minAgeMs: 0, limit: 500 })).recovered).toBe(0);
    const creates = remote.createCalls;
    await expect(caller().issueGatewayBilling({ installmentId, type: "boleto" })).resolves.toMatchObject({ reused: true, gatewayPaymentId: orphan!.id });
    expect(remote.createCalls).toBe(creates);
    expect(await localBillings(installmentId)).toHaveLength(1);
  });

  it("gateway recusou a criação: nada existe no Asaas, a intenção é encerrada como abandonada e nada local é criado", async () => {
    const installmentId = await seedInstallment("abandonada");
    remote.failCreate = true;
    await expect(caller().issueGatewayBilling({ installmentId, type: "pix" })).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    expect(await intentOf(installmentId)).toMatchObject({ status: "pending" });
    await recover(db as never, config, { minAgeMs: 0, limit: 500 });
    expect(await intentOf(installmentId)).toMatchObject({ status: "abandoned" });
    expect(await localBillings(installmentId)).toHaveLength(0);
  });

  it("parcela encerrada antes da recuperação: não cria cobrança local, vai para revisão manual com trilha de auditoria", async () => {
    const installmentId = await seedInstallment("encerrada");
    await failBillingEvent(installmentId);
    await expect(caller().issueGatewayBilling({ installmentId, type: "pix" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(installments).set({ status: "cancelled" }).where(eq(installments.id, installmentId));
    await recover(db as never, config, { minAgeMs: 0, limit: 500 });
    const intent = await intentOf(installmentId);
    expect(intent).toMatchObject({ status: "manual_review", lastError: "parcela_encerrada" });
    expect(await localBillings(installmentId)).toHaveLength(0);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "installment"), eq(auditLogs.entityId, String(installmentId)), eq(auditLogs.action, "gateway_orphan_needs_review")));
    expect(audits).toHaveLength(1);
  });
});
