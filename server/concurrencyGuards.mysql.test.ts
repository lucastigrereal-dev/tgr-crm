import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { billingRecords, contractDocuments, contracts, customers, domainEvents, financialTransactions, installments, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Prova em MySQL real de que os guards por affectedRows disparam com o formato de
// retorno verdadeiro do driver ([ResultSetHeader, fields]). Sem rede: Asaas usa
// chave fictícia e o webhook não chama o provedor.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const webhookToken = `kan31-${randomUUID()}`;

describe.skipIf(!integrationUrl)("guards de concorrência em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let adminId: number;
  let contractsRouter: typeof import("./routers/contracts").contractsRouter;
  let processAsaasWebhook: typeof import("./paymentGatewayWebhook").processAsaasWebhook;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    process.env.ASAAS_API_KEY = "kan31-local-key-never-sent";
    process.env.ASAAS_API_URL = "https://sandbox.asaas.com";
    process.env.ASAAS_WEBHOOK_TOKEN = webhookToken;
    ({ contractsRouter } = await import("./routers/contracts"));
    ({ processAsaasWebhook } = await import("./paymentGatewayWebhook"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    // O audit_logs/domain_events referenciam users: não dependa de a linha id=1 existir (banco novo = FK quebrada, flake por ordem).
    [{ id: adminId }] = await db.insert(users).values({ openId: `guard-admin-${runId}`, name: "Admin Guard", role: "admin" }).$returningId();
  });

  afterAll(async () => {
    process.env = previousEnv;
    await pool?.end();
  });

  async function seedContract(label: string) {
    const [customer] = await db.insert(customers).values({ fullName: `Guard ${label} ${runId}`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `GUARD-${label}-${runId}`, customerId: customer.id, status: "active", totalAmount: "300.00" }).$returningId();
    return contract.id;
  }

  it("markDocumentSigned repetido devolve alreadySigned e emite um único evento", async () => {
    const contractId = await seedContract("doc");
    const [document] = await db.insert(contractDocuments).values({ contractId, category: "contrato", filename: "c.pdf", storageKey: `guard/${runId}.pdf` }).$returningId();
    const caller = contractsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);

    const results = await Promise.all([
      caller.markDocumentSigned({ documentId: document.id }),
      caller.markDocumentSigned({ documentId: document.id }),
    ]);

    expect(results.map(result => result.alreadySigned).sort()).toEqual([false, true]);
    const events = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "contract.document.signed"), eq(domainEvents.aggregateId, String(document.id))));
    expect(events).toHaveLength(1);
  });

  it("dois eventos Asaas de confirmação do mesmo pagamento geram uma única receita", async () => {
    const contractId = await seedContract("asaas");
    const [installment] = await db.insert(installments).values({ contractId, sequence: 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount: "300.00" }).$returningId();
    const paymentId = `pay_${runId}`;
    await db.insert(billingRecords).values({ installmentId: installment.id, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: paymentId, amount: "300.00", dueDate: new Date("2026-10-10T12:00:00Z") });

    const confirmed = await processAsaasWebhook(webhookToken, { id: `evt_confirmed_${runId}`, event: "PAYMENT_CONFIRMED", payment: { id: paymentId, status: "CONFIRMED" } });
    const received = await processAsaasWebhook(webhookToken, { id: `evt_received_${runId}`, event: "PAYMENT_RECEIVED", payment: { id: paymentId, status: "RECEIVED" } });

    expect(confirmed).toMatchObject({ status: 200, installmentPaid: true });
    expect(received.status).toBe(200);
    expect(received.installmentPaid).toBeFalsy();
    const income = await db.select().from(financialTransactions).where(and(eq(financialTransactions.contractId, contractId), eq(financialTransactions.type, "income")));
    expect(income).toHaveLength(1);
    expect(income[0].amount).toBe("300.00");
    const [row] = await db.select().from(installments).where(eq(installments.id, installment.id));
    expect(row).toMatchObject({ status: "paid", paidAmount: "300.00" });
  });

  it("cobrança parcial confirmada por dois eventos diferentes soma o valor uma única vez", async () => {
    const contractId = await seedContract("asaas-partial");
    const [installment] = await db.insert(installments).values({ contractId, sequence: 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount: "300.00" }).$returningId();
    const paymentId = `pay_partial_${runId}`;
    await db.insert(billingRecords).values({ installmentId: installment.id, type: "boleto", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: paymentId, amount: "100.00", dueDate: new Date("2026-10-10T12:00:00Z") });

    await processAsaasWebhook(webhookToken, { id: `evt_partial_confirmed_${runId}`, event: "PAYMENT_CONFIRMED", payment: { id: paymentId, status: "CONFIRMED" } });
    await processAsaasWebhook(webhookToken, { id: `evt_partial_received_${runId}`, event: "PAYMENT_RECEIVED", payment: { id: paymentId, status: "RECEIVED" } });

    const income = await db.select().from(financialTransactions).where(and(eq(financialTransactions.contractId, contractId), eq(financialTransactions.type, "income")));
    expect(income.map(row => row.amount)).toEqual(["100.00"]);
    const [row] = await db.select().from(installments).where(eq(installments.id, installment.id));
    expect(row).toMatchObject({ status: "open", paidAmount: "100.00" });
  });
});

