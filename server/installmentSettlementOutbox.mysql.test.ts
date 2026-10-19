import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, billingRecords, captureRecords, commercialProjectSettings, contractDocuments, contracts, customers, domainEvents, financialTransactions, installments, opportunities, paymentGatewayWebhookEvents, proposals, resorts, salesCommissions, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { runTriggerDdl } from "./mysqlTestDdl";

// Issue #43 em MySQL REAL: `installment.paid`, `commission.created` e `commission.automatic.blocked` nascem na MESMA
// transação da baixa (manual e webhook Asaas). A falha é injetada no banco (trigger BEFORE INSERT em domain_events, só para
// as linhas deste teste), então o rollback é do MySQL, não de mock. Depois do commit, os eventos ficam na fila que a ponte do
// Financial drena (entrega 1× e recibo já provados em financialBridgeStarvation), e a reentrega do webhook não duplica nada.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("issue #43: fatos da baixa nascem com a baixa em MySQL real (rollback, entrega, reentrega e idempotência)", () => {
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
    process.env.ASAAS_WEBHOOK_TOKEN = "token-sintetico-43";
    svc = await import("./saleValidationService");
    ({ financeRouter } = await import("./routers/finance"));
    ({ processAsaasWebhook } = await import("./paymentGatewayWebhook"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `i43-admin-${runId}`, name: "Gerente #43", role: "admin" }).$returningId();
  });
  afterEach(async () => { for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); });
  afterAll(async () => {
    for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``);
    process.env = previousEnv;
    await pool?.end();
  });

  const paidPolicy = JSON.stringify({ linerRate: 0.02, closerRate: 0.03, ftbRate: 0.04, cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt" });

  async function seedSale(label: string, { validated }: { validated: boolean }) {
    const [liner] = await db.insert(users).values({ openId: `i43-liner-${label}-${runId}`, name: "Liner", role: "seller" }).$returningId();
    const [closer] = await db.insert(users).values({ openId: `i43-closer-${label}-${runId}`, name: "Closer", role: "seller" }).$returningId();
    const [resort] = await db.insert(resorts).values({ name: `Resort #43 ${label} ${runId}` } as never).$returningId();
    await db.insert(commercialProjectSettings).values({ resortId: resort.id, commissionPolicy: paidPolicy });
    const [customer] = await db.insert(customers).values({ fullName: `Cliente sintético #43 ${label} ${runId}`, status: "active" }).$returningId();
    const [opportunity] = await db.insert(opportunities).values({ customerId: customer.id, title: `Opp ${label}`, sellerId: closer.id } as never).$returningId();
    const [proposal] = await db.insert(proposals).values({ opportunityId: opportunity.id, reference: `P-43-${label}-${runId}`, productDescription: "Semana fixa", totalAmount: "10000.00", downPaymentAmount: "1000.00", installmentCount: 3 }).$returningId();
    await db.insert(captureRecords).values({ customerId: customer.id, resortId: resort.id, opportunityId: opportunity.id, linerId: liner.id, closerId: closer.id } as never);
    const [contract] = await db.insert(contracts).values({ number: `I43-${label}-${runId}`, customerId: customer.id, proposalId: proposal.id, status: "pending_signature", totalAmount: "10000.00", signedAt: new Date() }).$returningId();
    await db.insert(contractDocuments).values({ contractId: contract.id, category: "Contrato assinado", filename: "c.pdf", storageKey: `contracts/i43-${label}-${runId}.pdf`, signed: true, signedArtifact: true });
    const [inst] = await db.insert(installments).values({ contractId: contract.id, sequence: 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount: "1000.00", status: "open", paidAmount: "0.00" }).$returningId();
    if (validated) {
      await svc.confirmPayment(adminId, { contractId: contract.id, note: "conferido" });
      await svc.validateSale(adminId, { contractId: contract.id });
      await db.update(contracts).set({ status: "active" }).where(eq(contracts.id, contract.id));
    }
    return { contractId: contract.id, installmentId: inst.id, customerId: customer.id };
  }

  /** Recusa no banco o INSERT em domain_events que casar com `condition` (SQL sobre NEW). */
  async function failEventInsert(label: string, condition: string) {
    const name = `i43_${label}_${runId}`;
    await runTriggerDdl(pool, `CREATE TRIGGER \`${name}\` BEFORE INSERT ON domain_events FOR EACH ROW BEGIN IF ${condition} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'issue 43: falha injetada'; END IF; END`);
    triggers.push(name);
    return name;
  }
  const dropTrigger = async (name: string) => { await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); triggers.splice(triggers.indexOf(name), 1); };

  const eventsFor = (eventName: string, aggregateId: number) => db.select().from(domainEvents).where(and(eq(domainEvents.eventName, eventName as never), eq(domainEvents.aggregateId, String(aggregateId))));
  const commissionEventsFor = (contractId: number) => db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "commission.created" as never), like(domainEvents.payload, `%"contractId":${contractId},%`)));

  async function snapshot(contractId: number, installmentId: number) {
    const [inst] = await db.select().from(installments).where(eq(installments.id, installmentId));
    return {
      status: inst.status,
      paidAmount: inst.paidAmount,
      transactions: (await db.select().from(financialTransactions).where(eq(financialTransactions.contractId, contractId))).length,
      commissions: (await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId))).length,
      paidEvents: (await eventsFor("installment.paid", installmentId)).length,
      blockedEvents: (await eventsFor("commission.automatic.blocked", installmentId)).length,
      commissionEvents: (await commissionEventsFor(contractId)).length,
      paidAudits: (await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "installment"), eq(auditLogs.entityId, String(installmentId)), eq(auditLogs.action, "paid")))).length,
    };
  }
  const untouched = { status: "open", paidAmount: "0.00", transactions: 0, commissions: 0, paidEvents: 0, blockedEvents: 0, commissionEvents: 0, paidAudits: 0 };

  it("baixa manual: falha ao gravar installment.paid desfaz parcela, lançamento, comissões e eventos; repetir grava tudo uma vez só", async () => {
    const { contractId, installmentId } = await seedSale("manual-paid", { validated: true });
    const trigger = await failEventInsert("manual_paid", `NEW.idempotencyKey = 'installment-paid:${installmentId}'`);
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);

    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).rejects.toBeDefined();
    expect(await snapshot(contractId, installmentId)).toEqual(untouched);

    await dropTrigger(trigger);
    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).resolves.toMatchObject({ success: true, alreadyPaid: false, commissionBlocked: false });
    const after = await snapshot(contractId, installmentId);
    expect(after).toMatchObject({ status: "paid", paidAmount: "1000.00", transactions: 1, paidEvents: 1, blockedEvents: 0, paidAudits: 1 });
    expect(after.commissions).toBeGreaterThan(0);
    expect(after.commissionEvents).toBe(after.commissions); // um commission.created por comissão lançada
    const [paidEvent] = await eventsFor("installment.paid", installmentId);
    expect(paidEvent.idempotencyKey).toBe(`installment-paid:${installmentId}`);
    expect(JSON.parse(paidEvent.payload ?? "{}")).toMatchObject({ installmentId, contractId, paidAmount: "1000.00", source: "manual", commissionBlocked: false });

    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).resolves.toMatchObject({ alreadyPaid: true });
    expect(await snapshot(contractId, installmentId)).toEqual(after);
  });

  it("baixa manual: falha ao gravar commission.created desfaz a baixa inteira (inclusive as comissões já inseridas)", async () => {
    const { contractId, installmentId } = await seedSale("manual-commission", { validated: true });
    const trigger = await failEventInsert("manual_commission", `NEW.eventName = 'commission.created' AND NEW.payload LIKE '%"contractId":${contractId},%'`);
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);

    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).rejects.toBeDefined();
    expect(await snapshot(contractId, installmentId)).toEqual(untouched);

    await dropTrigger(trigger);
    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).resolves.toMatchObject({ alreadyPaid: false });
    const after = await snapshot(contractId, installmentId);
    expect(after).toMatchObject({ status: "paid", paidEvents: 1 });
    expect(after.commissionEvents).toBe(after.commissions);
  });

  it("webhook Asaas: falha ao gravar installment.paid desfaz pagamento, cobrança, registro do evento e auditoria; reentrega processa uma vez", async () => {
    const { contractId, installmentId, customerId } = await seedSale("webhook-paid", { validated: true });
    const paymentId = `pay-i43-${runId}`;
    const eventId = `evt-i43-${runId}`;
    const [billing] = await db.insert(billingRecords).values({ installmentId, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: paymentId, amount: "1000.00", dueDate: new Date("2026-10-10T12:00:00Z") }).$returningId();
    const trigger = await failEventInsert("webhook_paid", `NEW.idempotencyKey = 'installment-paid:${installmentId}'`);
    const payload = { id: eventId, event: "PAYMENT_CONFIRMED", payment: { id: paymentId, status: "CONFIRMED", billingType: "PIX" } };
    const webhookEvents = () => db.select().from(paymentGatewayWebhookEvents).where(eq(paymentGatewayWebhookEvents.gatewayEventId, eventId));
    const gatewayAudits = () => db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "billing_record"), eq(auditLogs.entityId, String(billing.id))));

    await expect(processAsaasWebhook("token-sintetico-43", payload)).rejects.toBeDefined();
    expect(await snapshot(contractId, installmentId)).toEqual(untouched);
    expect((await db.select().from(billingRecords).where(eq(billingRecords.id, billing.id)))[0].status).toBe("generated");
    expect(await webhookEvents()).toHaveLength(0); // sem "duplicado" falso na reentrega
    expect(await gatewayAudits()).toHaveLength(0);

    await dropTrigger(trigger);
    await expect(processAsaasWebhook("token-sintetico-43", payload)).resolves.toMatchObject({ status: 200, installmentPaid: true });
    const after = await snapshot(contractId, installmentId);
    expect(after).toMatchObject({ status: "paid", paidAmount: "1000.00", transactions: 1, paidEvents: 1, blockedEvents: 0 });
    expect(after.commissions).toBeGreaterThan(0);
    expect(after.commissionEvents).toBe(after.commissions);
    const [paidEvent] = await eventsFor("installment.paid", installmentId);
    expect(JSON.parse(paidEvent.payload ?? "{}")).toMatchObject({ installmentId, contractId, customerId, paidAmount: "1000.00", source: "asaas", gatewayPaymentId: paymentId, commissionBlocked: false });
    expect(await webhookEvents()).toHaveLength(1);
    expect(await gatewayAudits()).toHaveLength(1);

    await expect(processAsaasWebhook("token-sintetico-43", payload)).resolves.toMatchObject({ status: 200, duplicate: true });
    // Outro evento do gateway para o mesmo pagamento (ex.: PAYMENT_RECEIVED depois do CONFIRMED) também não duplica nada.
    await expect(processAsaasWebhook("token-sintetico-43", { ...payload, id: `${eventId}-received`, event: "PAYMENT_RECEIVED" })).resolves.toMatchObject({ status: 200, installmentPaid: false });
    expect(await snapshot(contractId, installmentId)).toEqual(after);
  });

  it("CRM-A27: deadlock do MySQL no meio do webhook Asaas é repetido do zero e o pagamento entra uma vez só (determinístico, sem depender de corrida)", async () => {
    const { contractId, installmentId } = await seedSale("webhook-deadlock", { validated: true });
    const paymentId = `pay-i43d-${runId}`;
    await db.insert(billingRecords).values({ installmentId, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: paymentId, amount: "1000.00", dueDate: new Date("2026-10-10T12:00:00Z") });
    // Tabela MEMORY não é transacional: o marcador sobrevive ao rollback da 1ª tentativa, então só a 1ª tentativa leva o erro 1213 (o mesmo que o InnoDB devolve num deadlock real).
    const marker = `i43_deadlock_marker_${runId}`;
    await pool.query(`CREATE TABLE \`${marker}\` (id INT PRIMARY KEY) ENGINE=MEMORY`);
    const name = `i43_deadlock_${runId}`;
    await runTriggerDdl(pool, `CREATE TRIGGER \`${name}\` BEFORE INSERT ON domain_events FOR EACH ROW BEGIN IF NEW.idempotencyKey = 'installment-paid:${installmentId}' AND (SELECT COUNT(*) FROM \`${marker}\`) = 0 THEN INSERT INTO \`${marker}\` VALUES (1); SIGNAL SQLSTATE '40001' SET MYSQL_ERRNO = 1213, MESSAGE_TEXT = 'Deadlock found when trying to get lock; try restarting transaction'; END IF; END`);
    triggers.push(name);
    try {
      const payload = { id: `evt-i43d-${runId}`, event: "PAYMENT_CONFIRMED", payment: { id: paymentId, status: "CONFIRMED", billingType: "PIX" } };
      await expect(processAsaasWebhook("token-sintetico-43", payload)).resolves.toMatchObject({ status: 200, installmentPaid: true });
      const [{ n }] = (await pool.query(`SELECT COUNT(*) AS n FROM \`${marker}\``))[0] as unknown as [{ n: number }];
      expect(Number(n)).toBe(1); // o deadlock foi injetado de fato, uma vez
      expect(await snapshot(contractId, installmentId)).toMatchObject({ status: "paid", transactions: 1, paidEvents: 1, paidAudits: 0 });
      await expect(processAsaasWebhook("token-sintetico-43", payload)).resolves.toMatchObject({ status: 200, duplicate: true });
    } finally {
      await dropTrigger(name);
      await pool.query(`DROP TABLE IF EXISTS \`${marker}\``);
    }
  });

  it("webhook Asaas com venda não validada: falha ao gravar commission.automatic.blocked desfaz tudo; depois o bloqueio e o pagamento nascem juntos", async () => {
    const { contractId, installmentId } = await seedSale("webhook-blocked", { validated: false });
    const paymentId = `pay-i43b-${runId}`;
    await db.insert(billingRecords).values({ installmentId, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: paymentId, amount: "1000.00", dueDate: new Date("2026-10-10T12:00:00Z") });
    const trigger = await failEventInsert("webhook_blocked", `NEW.idempotencyKey = 'commission-blocked:${installmentId}:sale_not_validated:asaas'`);
    const payload = { id: `evt-i43b-${runId}`, event: "PAYMENT_CONFIRMED", payment: { id: paymentId, status: "CONFIRMED", billingType: "PIX" } };

    await expect(processAsaasWebhook("token-sintetico-43", payload)).rejects.toBeDefined();
    expect(await snapshot(contractId, installmentId)).toEqual(untouched);

    await dropTrigger(trigger);
    await expect(processAsaasWebhook("token-sintetico-43", payload)).resolves.toMatchObject({ status: 200, installmentPaid: true });
    expect(await snapshot(contractId, installmentId)).toMatchObject({ status: "paid", transactions: 1, commissions: 0, commissionEvents: 0, paidEvents: 1, blockedEvents: 1 });
    const [paidEvent] = await eventsFor("installment.paid", installmentId);
    expect(JSON.parse(paidEvent.payload ?? "{}")).toMatchObject({ commissionBlocked: true });
  });

  it("entrega: installment.paid e commission.created ficam na fila do Financial (outbox) prontos para a ponte, sem recibo e com envelope válido", async () => {
    // A bomba em si (entrega 1×, recibo, sem reentrega após reinício) já é provada em financialBridgeStarvation.mysql.test.ts.
    // Aqui não ligamos outra bomba: duas bombas no mesmo banco, em arquivos paralelos, roubariam eventos uma da outra.
    const { contractId, installmentId } = await seedSale("delivery", { validated: true });
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);
    await caller.markInstallmentPaid({ id: installmentId, paymentMethod: "boleto" });
    const rows = [...(await eventsFor("installment.paid", installmentId)), ...(await commissionEventsFor(contractId))];
    expect(rows.length).toBeGreaterThan(1);

    const { FINANCIAL_EVENT_NAMES, financialBridgeEnvelope } = await import("./financialBridge");
    const project = { externalKey: randomUUID(), name: `SYN #43 ${runId}`, timezone: "America/Recife" };
    for (const row of rows) {
      expect(FINANCIAL_EVENT_NAMES).toContain(row.eventName);
      const envelope = financialBridgeEnvelope(row, project);
      expect(String(envelope.event.eventId)).toBe(String(row.id));
      expect(envelope.correlationId).toBe(`crm-fin-${row.id}`);
    }
  });
});
