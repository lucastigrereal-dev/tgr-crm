import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, billingRecords, captureRecords, commercialFractions, commercialProjectSettings, contractDocuments, contracts, customers, domainEvents, financialTransactions, installments, opportunities, paymentGatewayWebhookEvents, proposals, resorts, salesCommissions, units, users } from "../drizzle/schema";
import { FIVE_COMMISSION_DRAFT_V2 } from "../shared/commissionRulesV2";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { runTriggerDdl } from "./mysqlTestDdl";

// CRM-A13 em MySQL REAL: o motor V2 ligado à geração por parcela, TRAVADO por padrão, e a comissão sai na MESMA transação do evento.
// A falha é injetada no banco (trigger BEFORE INSERT em domain_events), então o rollback é do MySQL, não de mock. Dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("CRM-A13: comissão V2 por parcela, travada por padrão e atômica com o evento (MySQL real)", () => {
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
    process.env.ASAAS_WEBHOOK_TOKEN = "token-sintetico-v2";
    svc = await import("./saleValidationService");
    ({ financeRouter } = await import("./routers/finance"));
    ({ processAsaasWebhook } = await import("./paymentGatewayWebhook"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `v2-admin-${runId}`, name: "Gerente V2", role: "admin" }).$returningId();
  });
  afterEach(async () => { delete process.env.COMMISSION_V2_RELEASED; for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); });
  afterAll(async () => { for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); process.env = previousEnv; await pool?.end(); });

  const v2Policy = JSON.stringify({ linerRate: 0, closerRate: 0, ftbRate: 0, cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt", rulesV2: FIVE_COMMISSION_DRAFT_V2 });

  const v1AndV2Policy = JSON.stringify({ linerRate: 0.1, closerRate: 0.1, ftbRate: 0, cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt", rulesV2: FIVE_COMMISSION_DRAFT_V2 });

  /** Venda validada e ativa: entrada de R$ 1.000 dividida em parcelas, 2 frações vendidas (2 cotas), captador, consultor (liner) e fechador (closer) distintos. */
  async function seedSale(label: string, installmentAmounts = ["1000.00"], policyJson = v2Policy) {
    const [promoter] = await db.insert(users).values({ openId: `v2-promoter-${label}-${runId}`, name: "Captador", role: "seller" }).$returningId();
    const [liner] = await db.insert(users).values({ openId: `v2-liner-${label}-${runId}`, name: "Consultor", role: "seller" }).$returningId();
    const [closer] = await db.insert(users).values({ openId: `v2-closer-${label}-${runId}`, name: "Fechador", role: "seller" }).$returningId();
    const [resort] = await db.insert(resorts).values({ name: `Resort V2 ${label} ${runId}` } as never).$returningId();
    await db.insert(commercialProjectSettings).values({ resortId: resort.id, commissionPolicy: policyJson });
    const [customer] = await db.insert(customers).values({ fullName: `Cliente V2 ${label} ${runId}`, status: "active" }).$returningId();
    const [opportunity] = await db.insert(opportunities).values({ customerId: customer.id, title: `Opp ${label}`, sellerId: closer.id } as never).$returningId();
    const [proposal] = await db.insert(proposals).values({ opportunityId: opportunity.id, reference: `P-V2-${label}-${runId}`, productDescription: "Semana fixa", totalAmount: "10000.00", downPaymentAmount: "1000.00", installmentCount: 3 }).$returningId();
    await db.insert(captureRecords).values({ customerId: customer.id, resortId: resort.id, opportunityId: opportunity.id, promoterId: promoter.id, linerId: liner.id, closerId: closer.id } as never);
    const [contract] = await db.insert(contracts).values({ number: `V2-${label}-${runId}`, customerId: customer.id, proposalId: proposal.id, status: "pending_signature", totalAmount: "10000.00", signedAt: new Date() }).$returningId();
    await db.insert(contractDocuments).values({ contractId: contract.id, category: "Contrato assinado", filename: "c.pdf", storageKey: `contracts/v2-${label}-${runId}.pdf`, signed: true, signedArtifact: true });
    for (let n = 1; n <= 2; n += 1) {
      const [unit] = await db.insert(units).values({ resortId: resort.id, code: `U-V2-${label}-${n}-${runId}` }).$returningId();
      await db.insert(commercialFractions).values({ resortId: resort.id, unitId: unit.id, code: `F-V2-${label}-${n}-${runId}`, sequence: 1, status: "sold", currentContractId: contract.id });
    }
    const ids: number[] = [];
    for (const [index, amount] of installmentAmounts.entries()) {
      const [inst] = await db.insert(installments).values({ contractId: contract.id, sequence: index + 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount, status: "open", paidAmount: "0.00" }).$returningId();
      ids.push(inst.id);
    }
    await svc.confirmPayment(adminId, { contractId: contract.id, note: "conferido" });
    await svc.validateSale(adminId, { contractId: contract.id });
    await db.update(contracts).set({ status: "active" }).where(eq(contracts.id, contract.id));
    return { contractId: contract.id, installmentIds: ids, users: { promoter: promoter.id, liner: liner.id, closer: closer.id } };
  }

  async function failCommissionEvent(contractId: number) {
    const name = `v2_fail_commission_${runId}_${contractId}`;
    await runTriggerDdl(pool, `CREATE TRIGGER \`${name}\` BEFORE INSERT ON domain_events FOR EACH ROW BEGIN IF NEW.eventName = 'commission.created' AND NEW.payload LIKE '%"contractId":${contractId},%' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'falha injetada: commission.created'; END IF; END`);
    triggers.push(name);
    return name;
  }
  const dropTrigger = async (name: string) => { await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); triggers.splice(triggers.indexOf(name), 1); };

  async function snapshot(contractId: number, installmentId: number) {
    const [inst] = await db.select().from(installments).where(eq(installments.id, installmentId));
    const commissions = await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId));
    const created = (await db.select().from(domainEvents).where(eq(domainEvents.eventName, "commission.created" as never))).filter(event => String(event.payload).includes(`"contractId":${contractId},`));
    return {
      status: inst.status,
      transactions: (await db.select().from(financialTransactions).where(eq(financialTransactions.contractId, contractId))).length,
      paidEvents: (await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "installment.paid" as never), eq(domainEvents.aggregateId, String(installmentId))))).length,
      skipEvents: (await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "commission.automatic.skipped" as never), eq(domainEvents.aggregateId, String(installmentId))))).length,
      commissions: commissions.length,
      createdEvents: created.length,
      createdAudits: (await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "sales_commission"), eq(auditLogs.action, "created")))).filter(row => commissions.some(c => String(c.id) === row.entityId)).length,
      byRole: Object.fromEntries(commissions.map(row => [row.commissionRole, [row.sellerId, row.amount]])) as Record<string, [number, string]>,
    };
  }

  it("TRAVADO (padrão): com rulesV2 na política e COMMISSION_V2_RELEASED desligada, a baixa NÃO gera comissão V2; o skip de 0% fica rastreado", async () => {
    const { contractId, installmentIds } = await seedSale("travado");
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);
    await expect(caller.markInstallmentPaid({ id: installmentIds[0]!, paymentMethod: "pix" })).resolves.toMatchObject({ success: true });
    expect(await snapshot(contractId, installmentIds[0]!)).toMatchObject({ status: "paid", paidEvents: 1, skipEvents: 1, commissions: 0, createdEvents: 0 });
  });

  it("TRAVADO também é só 'true': valor diferente não libera", async () => {
    process.env.COMMISSION_V2_RELEASED = "1";
    const { contractId, installmentIds } = await seedSale("travado1");
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);
    await caller.markInstallmentPaid({ id: installmentIds[0]!, paymentMethod: "pix" });
    expect((await snapshot(contractId, installmentIds[0]!)).commissions).toBe(0);
  });

  it("LIBERADA (só neste teste): baixa manual gera captador (2 cotas), consultor e fechador; falha ao gravar commission.created desfaz a baixa inteira; repetir grava tudo uma vez só", async () => {
    process.env.COMMISSION_V2_RELEASED = "true";
    const { contractId, installmentIds, users: who } = await seedSale("manual");
    const installmentId = installmentIds[0]!;
    const trigger = await failCommissionEvent(contractId);
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);

    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).rejects.toBeDefined();
    expect(await snapshot(contractId, installmentId)).toMatchObject({ status: "open", transactions: 0, paidEvents: 0, commissions: 0, createdEvents: 0, createdAudits: 0 });

    await dropTrigger(trigger);
    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).resolves.toMatchObject({ success: true, alreadyPaid: false });
    const after = await snapshot(contractId, installmentId);
    expect(after).toMatchObject({ status: "paid", transactions: 1, paidEvents: 1, commissions: 3, createdEvents: 3, createdAudits: 3 });
    expect(after.byRole).toEqual({ promoter: [who.promoter, "800.00"], liner: [who.liner, "100.00"], closer: [who.closer, "100.00"] });
    await expect(caller.markInstallmentPaid({ id: installmentId, paymentMethod: "pix" })).resolves.toMatchObject({ alreadyPaid: true });
    expect(await snapshot(contractId, installmentId)).toMatchObject({ commissions: 3, createdEvents: 3 });
  });

  it("LIBERADA: webhook Asaas gera a mesma comissão na mesma transação do pagamento; falha em commission.created desfaz pagamento, cobrança e registro do evento; reentrega não duplica", async () => {
    process.env.COMMISSION_V2_RELEASED = "true";
    const { contractId, installmentIds } = await seedSale("webhook");
    const installmentId = installmentIds[0]!;
    const paymentId = `pay-v2-${runId}`;
    const eventId = `evt-v2-${runId}`;
    const [billing] = await db.insert(billingRecords).values({ installmentId, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: paymentId, amount: "1000.00", dueDate: new Date("2026-10-10T12:00:00Z") }).$returningId();
    const trigger = await failCommissionEvent(contractId);
    const payload = { id: eventId, event: "PAYMENT_CONFIRMED", payment: { id: paymentId, status: "CONFIRMED", billingType: "PIX" } };
    const webhookEvents = () => db.select().from(paymentGatewayWebhookEvents).where(eq(paymentGatewayWebhookEvents.gatewayEventId, eventId));

    await expect(processAsaasWebhook("token-sintetico-v2", payload)).rejects.toBeDefined();
    expect(await snapshot(contractId, installmentId)).toMatchObject({ status: "open", transactions: 0, paidEvents: 0, commissions: 0, createdEvents: 0 });
    expect((await db.select().from(billingRecords).where(eq(billingRecords.id, billing.id)))[0]!.status).toBe("generated");
    expect(await webhookEvents()).toHaveLength(0);

    await dropTrigger(trigger);
    await expect(processAsaasWebhook("token-sintetico-v2", payload)).resolves.toMatchObject({ status: 200, installmentPaid: true });
    expect(await snapshot(contractId, installmentId)).toMatchObject({ status: "paid", paidEvents: 1, commissions: 3, createdEvents: 3, createdAudits: 3 });
    expect(await webhookEvents()).toHaveLength(1);
    await expect(processAsaasWebhook("token-sintetico-v2", payload)).resolves.toMatchObject({ status: 200, duplicate: true });
    expect(await snapshot(contractId, installmentId)).toMatchObject({ commissions: 3, createdEvents: 3 });
  });

  it("LIBERADA: entrada em duas parcelas libera metade em cada uma e o total fecha exatamente nos valores do motor (nunca passa)", async () => {
    process.env.COMMISSION_V2_RELEASED = "true";
    const { contractId, installmentIds } = await seedSale("parcelas", ["500.00", "500.00"]);
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);
    await caller.markInstallmentPaid({ id: installmentIds[0]!, paymentMethod: "pix" });
    const half = await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId));
    expect(half.map(row => [row.commissionRole, row.amount]).sort()).toEqual([["closer", "50.00"], ["liner", "50.00"], ["promoter", "400.00"]]);
    await caller.markInstallmentPaid({ id: installmentIds[1]!, paymentMethod: "pix" });
    const all = await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId));
    expect(all).toHaveLength(6);
    const total = (role: string) => all.filter(row => row.commissionRole === role).reduce((sum, row) => sum + Number(row.amount), 0);
    expect([total("promoter"), total("liner"), total("closer")]).toEqual([800, 100, 100]);
  });
  it("VERSÃO FIXADA POR CONTRATO: V1 já gerou a 1ª parcela; liberar o V2 no meio NÃO troca de regra nas parcelas seguintes", async () => {
    const { contractId, installmentIds } = await seedSale("travessia", ["500.00", "500.00"], v1AndV2Policy);
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);
    await caller.markInstallmentPaid({ id: installmentIds[0]!, paymentMethod: "pix" }); // V2 travado: V1 (10% sobre o saldo do contrato, pro-rata da entrada)
    const first = await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId));
    expect(first.map(row => [row.commissionRole, row.amount, row.ruleVersion]).sort()).toEqual([["closer", "450.00", "v1"], ["liner", "450.00", "v1"]]);
    process.env.COMMISSION_V2_RELEASED = "true"; // liberado no meio do contrato
    await caller.markInstallmentPaid({ id: installmentIds[1]!, paymentMethod: "pix" });
    const all = await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId));
    expect(all.every(row => row.ruleVersion === "v1")).toBe(true);
    expect(all.some(row => row.commissionRole === "promoter")).toBe(false);
    const total = (role: string) => all.filter(row => row.commissionRole === role).reduce((sum, row) => sum + Number(row.amount), 0);
    expect([total("liner"), total("closer")]).toEqual([900, 900]); // fecha exatamente na política V1, sem subtrair V1 de V2
  });

  it("V2 fixado e travado de novo: o travamento vence e nenhuma parcela nova gera comissão", async () => {
    process.env.COMMISSION_V2_RELEASED = "true";
    const { contractId, installmentIds } = await seedSale("retrava", ["500.00", "500.00"]);
    const caller = financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);
    await caller.markInstallmentPaid({ id: installmentIds[0]!, paymentMethod: "pix" });
    expect((await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId))).every(row => row.ruleVersion === "v2")).toBe(true);
    delete process.env.COMMISSION_V2_RELEASED;
    await caller.markInstallmentPaid({ id: installmentIds[1]!, paymentMethod: "pix" });
    expect(await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId))).toHaveLength(3);
  });
});
