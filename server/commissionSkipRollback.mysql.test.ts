import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, billingRecords, captureRecords, commercialProjectSettings, contractDocuments, contracts, customers, domainEvents, financialTransactions, installments, opportunities, paymentGatewayWebhookEvents, proposals, resorts, salesCommissions, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { runTriggerDdl } from "./mysqlTestDdl";

// Issue #38 (2) em MySQL REAL: o registro `commission.automatic.skipped` nasce na mesma transação da baixa (manual e webhook).
// A falha é injetada no banco (trigger BEFORE INSERT em domain_events, só para a chave deste teste), então o rollback é do MySQL, não de mock.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("issue #38 (2): falha ao gravar o skip desfaz a baixa inteira em MySQL real (manual e webhook)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let svc: typeof import("./saleValidationService");
  let financeRouter: typeof import("./routers/finance")["financeRouter"];
  let processAsaasWebhook: typeof import("./paymentGatewayWebhook")["processAsaasWebhook"];
  let adminId: number;
  const previousEnv = { ...process.env };
  const triggers: string[] = [];

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    process.env.ASAAS_API_KEY = "sintetico-nao-real";
    process.env.ASAAS_API_URL = "https://asaas.invalid";
    process.env.ASAAS_WEBHOOK_TOKEN = "token-sintetico-f2";
    svc = await import("./saleValidationService");
    ({ financeRouter } = await import("./routers/finance"));
    ({ processAsaasWebhook } = await import("./paymentGatewayWebhook"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `f2-admin-${runId}`, name: "Gerente F2", role: "admin" }).$returningId();
  });
  afterEach(async () => { for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); });
  afterAll(async () => { for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); process.env = previousEnv; await pool?.end(); });

  const zeroPolicy = JSON.stringify({ linerRate: 0, closerRate: 0, ftbRate: 0, cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt" });

  async function seedSale(label: string) {
    const [liner] = await db.insert(users).values({ openId: `f2-liner-${label}-${runId}`, name: "Liner", role: "seller" }).$returningId();
    const [closer] = await db.insert(users).values({ openId: `f2-closer-${label}-${runId}`, name: "Closer", role: "seller" }).$returningId();
    const [resort] = await db.insert(resorts).values({ name: `Resort F2 ${label} ${runId}` } as never).$returningId();
    await db.insert(commercialProjectSettings).values({ resortId: resort.id, commissionPolicy: zeroPolicy });
    const [customer] = await db.insert(customers).values({ fullName: `Cliente F2 ${label} ${runId}`, status: "active" }).$returningId();
    const [opportunity] = await db.insert(opportunities).values({ customerId: customer.id, title: `Opp ${label}`, sellerId: closer.id } as never).$returningId();
    const [proposal] = await db.insert(proposals).values({ opportunityId: opportunity.id, reference: `P-F2-${label}-${runId}`, productDescription: "Semana fixa", totalAmount: "10000.00", downPaymentAmount: "1000.00", installmentCount: 3 }).$returningId();
    await db.insert(captureRecords).values({ customerId: customer.id, resortId: resort.id, opportunityId: opportunity.id, linerId: liner.id, closerId: closer.id } as never);
    const [contract] = await db.insert(contracts).values({ number: `F2-${label}-${runId}`, customerId: customer.id, proposalId: proposal.id, status: "pending_signature", totalAmount: "10000.00", signedAt: new Date() }).$returningId();
    await db.insert(contractDocuments).values({ contractId: contract.id, category: "Contrato assinado", filename: "c.pdf", storageKey: `contracts/f2-${label}-${runId}.pdf`, signed: true, signedArtifact: true });
    const [inst] = await db.insert(installments).values({ contractId: contract.id, sequence: 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount: "1000.00", status: "open", paidAmount: "0.00" }).$returningId();
    await svc.confirmPayment(adminId, { contractId: contract.id, note: "conferido" });
    await svc.validateSale(adminId, { contractId: contract.id });
    await db.update(contracts).set({ status: "active" }).where(eq(contracts.id, contract.id));
    return { contractId: contract.id, installmentId: inst.id };
  }

  async function failSkipInsertFor(installmentId: number) {
    const name = `f2_fail_skip_${runId}_${installmentId}`;
    await runTriggerDdl(pool, `CREATE TRIGGER \`${name}\` BEFORE INSERT ON domain_events FOR EACH ROW BEGIN IF NEW.idempotencyKey = 'commission-skipped:${installmentId}:zero_rate' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'f2: falha injetada no skip'; END IF; END`);
    triggers.push(name);
    return name;
  }
  const dropTrigger = async (name: string) => { await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); triggers.splice(triggers.indexOf(name), 1); };

  async function snapshot(contractId: number, installmentId: number) {
    const [inst] = await db.select().from(installments).where(eq(installments.id, installmentId));
    return {
      status: inst.status,
      paidAmount: inst.paidAmount,
      paidAt: inst.paidAt,
      transactions: (await db.select().from(financialTransactions).where(eq(financialTransactions.contractId, contractId))).length,
      skipEvents: (await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "commission.automatic.skipped" as never), eq(domainEvents.aggregateId, String(installmentId))))).length,
      skipAudits: (await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "installment"), eq(auditLogs.entityId, String(installmentId)), eq(auditLogs.action, "commission_skipped")))).length,
      paidEvents: (await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "installment.paid" as never), eq(domainEvents.aggregateId, String(installmentId))))).length,
      commissions: (await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId))).length,
    };
  }

  it("baixa manual: erro do banco no skip desfaz parcela, lançamento financeiro, auditoria e eventos; repetir depois da falha funciona uma vez só", async () => {
    const { contractId, installmentId } = await seedSale("manual");
    const trigger = await failSkipInsertFor(installmentId);
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);

    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).rejects.toBeDefined();
    expect(await snapshot(contractId, installmentId)).toEqual({ status: "open", paidAmount: "0.00", paidAt: null, transactions: 0, skipEvents: 0, skipAudits: 0, paidEvents: 0, commissions: 0 });

    await dropTrigger(trigger);
    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).resolves.toMatchObject({ success: true, alreadyPaid: false });
    const after = await snapshot(contractId, installmentId);
    expect(after).toMatchObject({ status: "paid", paidAmount: "1000.00", transactions: 1, skipEvents: 1, skipAudits: 1, paidEvents: 1, commissions: 0 });
    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).resolves.toMatchObject({ alreadyPaid: true });
    expect((await snapshot(contractId, installmentId)).skipEvents).toBe(1);
  });

  it("webhook Asaas: erro do banco no skip desfaz pagamento, cobrança e o registro do evento (sem 'duplicado' falso); reentrega do mesmo evento processa uma vez", async () => {
    const { contractId, installmentId } = await seedSale("webhook");
    const paymentId = `pay-f2-${runId}`;
    const eventId = `evt-f2-${runId}`;
    const [billing] = await db.insert(billingRecords).values({ installmentId, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: paymentId, amount: "1000.00", dueDate: new Date("2026-10-10T12:00:00Z") }).$returningId();
    const trigger = await failSkipInsertFor(installmentId);
    const payload = { id: eventId, event: "PAYMENT_CONFIRMED", payment: { id: paymentId, status: "CONFIRMED", billingType: "PIX" } };
    const webhookEvents = () => db.select().from(paymentGatewayWebhookEvents).where(eq(paymentGatewayWebhookEvents.gatewayEventId, eventId));

    await expect(processAsaasWebhook("token-sintetico-f2", payload)).rejects.toBeDefined();
    expect(await snapshot(contractId, installmentId)).toEqual({ status: "open", paidAmount: "0.00", paidAt: null, transactions: 0, skipEvents: 0, skipAudits: 0, paidEvents: 0, commissions: 0 });
    expect((await db.select().from(billingRecords).where(eq(billingRecords.id, billing.id)))[0].status).toBe("generated");
    expect(await webhookEvents()).toHaveLength(0);

    await dropTrigger(trigger);
    await expect(processAsaasWebhook("token-sintetico-f2", payload)).resolves.toMatchObject({ status: 200, installmentPaid: true });
    expect(await snapshot(contractId, installmentId)).toMatchObject({ status: "paid", paidAmount: "1000.00", transactions: 1, skipEvents: 1, skipAudits: 1, paidEvents: 1, commissions: 0 });
    expect((await db.select().from(billingRecords).where(eq(billingRecords.id, billing.id)))[0].status).toBe("paid");
    expect(await webhookEvents()).toHaveLength(1);
    await expect(processAsaasWebhook("token-sintetico-f2", payload)).resolves.toMatchObject({ status: 200, duplicate: true });
    expect((await snapshot(contractId, installmentId)).skipEvents).toBe(1);
  });
});
