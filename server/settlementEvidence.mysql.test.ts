import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, billingRecords, contracts, customers, domainEvents, financialTransactions, installments, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-H1 em MySQL real: parcela paga carrega a evidência do recebimento; webhook = gateway_confirmed; conciliação = bank_reconciled. Dados SYN-.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("H1: evidência do recebimento da parcela", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let adminId = 0, customerId = 0, seq = 0;
  const previousEnv = { ...process.env };
  const finance = async () => (await import("./routers/finance")).financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    process.env.ASAAS_API_KEY = "sintetico-nao-real"; process.env.ASAAS_API_URL = "https://asaas.invalid"; process.env.ASAAS_WEBHOOK_TOKEN = "token-sintetico-h1";
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    adminId = (await db.insert(users).values({ openId: `h1-admin-${runId}`, name: "SYN financeiro", role: "admin" }).$returningId())[0]!.id;
    customerId = (await db.insert(customers).values({ fullName: `SYN H1 ${runId}`, status: "active" }).$returningId())[0]!.id;
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  async function seed(amounts: string[], paid: boolean[] = []) {
    seq += 1;
    const contractId = (await db.insert(contracts).values({ number: `H1-${seq}-${runId}`, customerId, usageModel: "fixed_week", status: "pending_signature", totalAmount: "1000.00" }).$returningId())[0]!.id;
    const ids: number[] = [];
    for (const [index, amount] of amounts.entries()) {
      ids.push((await db.insert(installments).values({ contractId, sequence: index + 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount, status: paid[index] ? "paid" : "open", paidAmount: paid[index] ? amount : "0.00", paidAt: paid[index] ? new Date(Date.now() - (amounts.length - index) * 60_000) : null }).$returningId())[0]!.id);
    }
    return { contractId, ids };
  }
  const evidence = async (id: number) => (await db.select({ e: installments.settlementEvidence }).from(installments).where(eq(installments.id, id)))[0]!.e;
  const paidPayload = async (id: number) => JSON.parse((await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "installment.paid" as never), eq(domainEvents.aggregateId, String(id)))))[0]!.payload ?? "{}");

  it("baixa manual = receipt_claimed; o evento só leva o campo com INSTALLMENT_EVIDENCE_IN_EVENT", async () => {
    const off = await seed(["100.00"]);
    delete process.env.INSTALLMENT_EVIDENCE_IN_EVENT;
    await (await finance()).markInstallmentPaid({ id: off.ids[0]!, paymentMethod: "pix" });
    expect(await evidence(off.ids[0]!)).toBe("receipt_claimed");
    expect(await paidPayload(off.ids[0]!)).not.toHaveProperty("settlementEvidence");
    const on = await seed(["100.00"]);
    process.env.INSTALLMENT_EVIDENCE_IN_EVENT = "true";
    try { await (await finance()).markInstallmentPaid({ id: on.ids[0]!, paymentMethod: "pix" }); } finally { delete process.env.INSTALLMENT_EVIDENCE_IN_EVENT; }
    expect(await paidPayload(on.ids[0]!)).toMatchObject({ settlementEvidence: "receipt_claimed" });
  });

  it("webhook confirmado do gateway = gateway_confirmed", async () => {
    const { ids } = await seed(["100.00"]);
    const paymentId = `pay-h1-${runId}`;
    await db.insert(billingRecords).values({ installmentId: ids[0]!, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: paymentId, amount: "100.00", dueDate: new Date("2026-10-10T12:00:00Z") });
    const { processAsaasWebhook } = await import("./paymentGatewayWebhook");
    await expect(processAsaasWebhook("token-sintetico-h1", { id: `evt-h1-${runId}`, event: "PAYMENT_CONFIRMED", payment: { id: paymentId, status: "CONFIRMED", billingType: "PIX" } })).resolves.toMatchObject({ status: 200 });
    expect(await evidence(ids[0]!)).toBe("gateway_confirmed");
  });

  const entryFor = async (contractId: number, installmentId: number | null, amount: string, type: "income" | "expense" = "income") =>
    (await db.insert(financialTransactions).values({ contractId, type, category: type === "income" ? "Parcela de contrato" : "Estorno", description: "SYN lançamento", amount, dueDate: new Date("2026-10-04T12:00:00Z"), paidAt: new Date(), status: "paid", installmentId } as never).$returningId())[0]!.id;
  const reconcile = async (entryId: number, ref: string) => (await finance()).reconcileEntry({ id: entryId, reconciliationReference: `EXT-H1-${runId}-${ref}` });
  const auditCount = async (entryId: number, action: string) => (await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "financial_transaction"), eq(auditLogs.entityId, String(entryId)), eq(auditLogs.action, action)))).length;

  it("P1: duas parcelas iguais — só a explicitamente vinculada ao lançamento é promovida (nunca infere por valor)", async () => {
    const { contractId, ids } = await seed(["100.00", "100.00"], [true, true]);
    await reconcile(await entryFor(contractId, ids[1]!, "100.00"), "1");
    expect(await Promise.all(ids.map(evidence))).toEqual(["receipt_claimed", "bank_reconciled"]);
  });

  it("P1: despesa/estorno nunca promove; entrada sem vínculo explícito (ex.: Sales) não promove e deixa auditoria", async () => {
    const { contractId, ids } = await seed(["100.00"], [true]);
    const expense = await entryFor(contractId, ids[0]!, "100.00", "expense");
    await reconcile(expense, "2");
    expect(await evidence(ids[0]!)).toBe("receipt_claimed");
    expect(await auditCount(expense, "reconcile_installments_skipped")).toBe(1);
    const unlinked = await entryFor(contractId, null, "100.00");
    await reconcile(unlinked, "3");
    expect(await evidence(ids[0]!)).toBe("receipt_claimed");
    expect(await auditCount(unlinked, "reconcile_installments_skipped")).toBe(1);
  });

  it("baixa manual vincula o lançamento à parcela e a conciliação promove a evidência", async () => {
    const { contractId, ids } = await seed(["100.00"]);
    await (await finance()).markInstallmentPaid({ id: ids[0]!, paymentMethod: "pix" });
    const [entry] = await db.select().from(financialTransactions).where(eq(financialTransactions.contractId, contractId));
    expect(entry!.installmentId).toBe(ids[0]);
    await reconcile(entry!.id, "4");
    expect(await evidence(ids[0]!)).toBe("bank_reconciled");
  });

  it("P2: webhook tardio não rebaixa bank_reconciled (evidência só sobe)", async () => {
    const { ids } = await seed(["100.00"]);
    await db.update(installments).set({ settlementEvidence: "bank_reconciled" }).where(eq(installments.id, ids[0]!));
    const paymentId = `pay-h1b-${runId}`;
    await db.insert(billingRecords).values({ installmentId: ids[0]!, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: paymentId, amount: "100.00", dueDate: new Date("2026-10-10T12:00:00Z") });
    const { processAsaasWebhook } = await import("./paymentGatewayWebhook");
    await processAsaasWebhook("token-sintetico-h1", { id: `evt-h1b-${runId}`, event: "PAYMENT_CONFIRMED", payment: { id: paymentId, status: "CONFIRMED", billingType: "PIX" } });
    expect(await evidence(ids[0]!)).toBe("bank_reconciled");
  });

  it("P1: a promoção chega ao consumidor — financial.entry.reconciled leva installmentIds e evidência só com a flag", async () => {
    const { toIntegrationEvent } = await import("../shared/integrationContract");
    const { contractId, ids } = await seed(["100.00"], [true]);
    const entry = await entryFor(contractId, ids[0]!, "100.00");
    await reconcile(entry, "5");
    const row = (await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "financial.entry.reconciled" as never), eq(domainEvents.aggregateId, String(entry)))))[0]!;
    const wire = () => toIntegrationEvent({ id: row.id, eventName: row.eventName as never, aggregateType: row.aggregateType, aggregateId: row.aggregateId, actorUserId: row.actorUserId, payload: row.payload, occurredAt: row.occurredAt }).payload;
    delete process.env.INSTALLMENT_EVIDENCE_IN_EVENT;
    expect(wire()).not.toHaveProperty("installmentIds");
    process.env.INSTALLMENT_EVIDENCE_IN_EVENT = "true";
    try { expect(wire()).toMatchObject({ installmentIds: [ids[0]], settlementEvidence: "bank_reconciled" }); } finally { delete process.env.INSTALLMENT_EVIDENCE_IN_EVENT; }
  });
});
