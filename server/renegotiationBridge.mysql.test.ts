import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { billingRecords, contracts, customers, domainEvents, installments, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Rodada 3: renegociar -> installment.renegotiation.applied entra na fila da ponte CRM->Financial -> chega com o payload do contrato
// (sem enriquecimento), uma vez, e a parcela nova sai como installment.scheduled. Receptor simulado local; dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("ponte CRM->Financial encaminha installment.renegotiation.applied (MySQL real)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let server: Server;
  let baseUrl = "";
  const bodies = new Map<number, Array<Record<string, any>>>();
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        const id = Number(body.event.eventId);
        bodies.set(id, [...(bodies.get(id) ?? []), body]);
        res.writeHead(201, { "Content-Type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });
  afterAll(async () => { process.env = previousEnv; await new Promise(resolve => server?.close(resolve)); await pool?.end(); });

  it("o evento está na lista da ponte, sai com os campos do contrato e é entregue uma única vez", async () => {
    const { startFinancialBridgePump, FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    const { financeRouter } = await import("./routers/finance");
    expect(FINANCIAL_EVENT_NAMES).toContain("installment.renegotiation.applied");

    const [proposer] = await db.insert(users).values({ openId: `rb-prop-${runId}`, name: "Proponente", role: "finance" }).$returningId();
    const [approver] = await db.insert(users).values({ openId: `rb-appr-${runId}`, name: "Aprovador", role: "finance" }).$returningId();
    const [customer] = await db.insert(customers).values({ fullName: `Cliente RB ${runId}`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `RB-${runId}`, customerId: customer.id, status: "active", totalAmount: "3000.00" }).$returningId();
    const [inst] = await db.insert(installments).values({ contractId: contract.id, sequence: 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount: "1000.00", status: "overdue", paidAmount: "0.00" }).$returningId();
    const [billing] = await db.insert(billingRecords).values({ installmentId: inst.id, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: `pay_rb_${runId}`, amount: "1000.00", dueDate: new Date("2026-10-10T12:00:00Z") }).$returningId();
    const as = (id: number) => financeRouter.createCaller({ user: { id, role: "finance" } } as never);
    const { id } = await as(proposer.id).createRenegotiation({ installmentId: inst.id, proposedAmount: 900, proposedDueDate: "2026-12-15" });
    await as(approver.id).approveRenegotiation({ id });
    const applied = await as(approver.id).applyRenegotiation({ id });
    await expect(as(approver.id).applyRenegotiation({ id })).rejects.toMatchObject({ code: "CONFLICT" });

    // 1 evento só, com chave idempotente
    const events = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "installment.renegotiation.applied" as never), eq(domainEvents.aggregateId, String(id))));
    expect(events).toHaveLength(1);
    expect(events[0]!.idempotencyKey).toBe(`installment-renegotiation-applied:${id}`);
    const scheduled = (await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "installment.scheduled" as never), eq(domainEvents.aggregateId, String(applied.newInstallmentId)))))[0]!;

    const eventId = events[0]!.id;
    const placeholders = FINANCIAL_EVENT_NAMES.map(() => "?").join(",");
    const [backlog] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS pending FROM domain_events d LEFT JOIN audit_logs a ON a.idempotencyKey = CONCAT('financial-event:', d.id) WHERE a.id IS NULL AND d.id <= ? AND d.eventName IN (${placeholders})`, [Math.max(eventId, scheduled.id), ...FINANCIAL_EVENT_NAMES]);
    const pump = startFinancialBridgePump(baseUrl, "syn-fin-key", { externalKey: randomUUID(), name: `SYN renegotiation ${runId}`, timezone: "America/Recife" }, { autoStart: false, onError: () => undefined });
    try {
      for (let i = 0; i < Math.ceil(Number(backlog[0]?.pending ?? 0) / 100) + 30 && !(bodies.get(eventId) && bodies.get(scheduled.id)); i += 1) await pump.tick();
      for (let i = 0; i < 3; i += 1) await pump.tick(); // mais ciclos: recibo impede nova entrega
    } finally { pump.stop?.(); }

    const delivered = bodies.get(eventId) ?? [];
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.source).toBe("crm");
    expect(delivered[0]!.event).toMatchObject({ contractVersion: "tgr.events.v1", eventName: "installment.renegotiation.applied", aggregate: { type: "installment_renegotiation", id: String(id) } });
    // exatamente os campos do contrato: sem customerId (sem enriquecimento) e sem nada além do permitido
    expect(delivered[0]!.event.payload).toEqual({ installmentId: inst.id, newInstallmentId: applied.newInstallmentId, contractId: contract.id, proposalAmount: 900, cancelledBillingIds: [billing.id], gatewayPaymentIds: [`pay_rb_${runId}`] });
    // a parcela nova também chega (installment.scheduled) e a original não é anunciada como aberta
    expect(bodies.get(scheduled.id)).toHaveLength(1);
    expect(bodies.get(scheduled.id)![0]!.event.payload).toMatchObject({ installmentId: applied.newInstallmentId, contractId: contract.id, sequence: 2, amount: "900.00" });
  });
});
