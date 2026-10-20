import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, financialTransactions, contracts, customers, domainEvents, financialProjectMap, resorts, users } from "../drizzle/schema";
import { acquireFinancialPumpTestLock } from "./testPumpLock";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-A01 em MySQL real: mapa empreendimento -> projeto do Financial. Dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("A01: projeto do Financial por empreendimento", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let server: Server;
  let baseUrl = "";
  let adminId = 0;
  let customerId = 0;
  const projectOf = new Map<number, string>();
  const previousEnv = { ...process.env };
  const fallback = { externalKey: `syn-default-${runId}`, name: `SYN padrão ${runId}`, timezone: "America/Recife" };

  let releasePumpLock: (() => Promise<void>) | undefined;
  beforeAll(async () => { releasePumpLock = await acquireFinancialPumpTestLock(integrationUrl!); }, 600_000);
  afterAll(async () => { await releasePumpLock?.(); });
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
        projectOf.set(Number(body.event.eventId), String(body.project.externalKey));
        res.writeHead(201, { "Content-Type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    [{ id: adminId }] = await db.insert(users).values({ openId: `pm-admin-${runId}`, name: "Admin Sintético", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `SYN Mapa ${runId}`, email: `syn.mapa.${runId}@example.test`, status: "active" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await new Promise(resolve => server?.close(resolve)); await pool?.end(); });

  async function contractIn(label: string, resortId: number | null) {
    const [row] = await db.insert(contracts).values({ number: `PM-${label}-${runId}`, customerId, usageModel: "fixed_week", status: "draft", totalAmount: "1000.00", resortId } as never).$returningId();
    const [event] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(row.id), actorUserId: null, payload: JSON.stringify({ status: "active" }), occurredAt: new Date() }).$returningId();
    return event.id;
  }
  async function drain(ids: number[], projectMapEnabled: boolean) {
    const { startFinancialBridgePump } = await import("./financialBridge");
    const pump = startFinancialBridgePump(baseUrl, "syn-fin-key", fallback, { autoStart: false, projectMapEnabled, onError: () => undefined });
    try { for (let i = 0; i < 200 && ids.some(id => !projectOf.has(id)); i += 1) await pump.tick(); } finally { pump.stop(); }
  }

  it("com a flag ligada, empreendimentos diferentes vão a projetos diferentes; sem linha e sem empreendimento usam o padrão; linha inativa também", async () => {
    const [a] = await db.insert(resorts).values({ name: `Resort PM-A ${runId}` } as never).$returningId();
    const [b] = await db.insert(resorts).values({ name: `Resort PM-B ${runId}` } as never).$returningId();
    const [c] = await db.insert(resorts).values({ name: `Resort PM-C ${runId}` } as never).$returningId();
    const [d] = await db.insert(resorts).values({ name: `Resort PM-D ${runId}` } as never).$returningId();
    await db.insert(financialProjectMap).values([
      { resortId: a.id, externalKey: `syn-a-${runId}`, name: "Projeto A", timezone: "America/Recife" },
      { resortId: b.id, externalKey: `syn-b-${runId}`, name: "Projeto B", timezone: "America/Sao_Paulo" },
      { resortId: d.id, externalKey: `syn-d-${runId}`, name: "Projeto D", timezone: "America/Recife", active: false },
    ]);
    const ea = await contractIn("A", a.id), eb = await contractIn("B", b.id), ec = await contractIn("C", c.id), ed = await contractIn("D", d.id), eo = await contractIn("O", null);
    await drain([ea, eb, ec, ed, eo], true);
    expect(projectOf.get(ea)).toBe(`syn-a-${runId}`);
    expect(projectOf.get(eb)).toBe(`syn-b-${runId}`);
    expect(projectOf.get(ec)).toBe(fallback.externalKey);
    expect(projectOf.get(ed)).toBe(fallback.externalKey);
    expect(projectOf.get(eo)).toBe(fallback.externalKey);
    const receipts = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `financial-event:${ea}`));
    expect(receipts).toHaveLength(1);
  });

  it("eventos do Financial sem contractId no payload (criação e reconciliação de lançamento, repasse, comissão, parcela) vão ao MESMO projeto do contrato", async () => {
    const [r] = await db.insert(resorts).values({ name: `Resort PM-ENT ${runId}` } as never).$returningId();
    await db.insert(financialProjectMap).values({ resortId: r.id, externalKey: `syn-ent-${runId}`, name: "Projeto ENT", timezone: "America/Recife" });
    const [ct] = await db.insert(contracts).values({ number: `PM-ENT-${runId}`, customerId, usageModel: "fixed_week", status: "draft", totalAmount: "1000.00", resortId: r.id } as never).$returningId();
    const [tx1] = await db.insert(financialTransactions).values({ contractId: ct.id, type: "income", category: "SYN", description: "lançamento sintético", amount: "10.00" } as never).$returningId();
    const [tx2] = await db.insert(financialTransactions).values({ contractId: null, type: "expense", category: "SYN", description: "despesa sem contrato", amount: "5.00" } as never).$returningId();
    const ev = async (eventName: string, aggregateType: string, aggregateId: number, payload: object) =>
      (await db.insert(domainEvents).values({ eventName, aggregateType, aggregateId: String(aggregateId), actorUserId: null, payload: JSON.stringify(payload), occurredAt: new Date() } as never).$returningId())[0]!.id;
    const created = await ev("financial.entry.created", "financial_transaction", tx1.id, { type: "income", amount: "10.00" });
    const reconciled = await ev("financial.entry.reconciled", "financial_transaction", tx1.id, { reference: "R1" });
    const noContractCreated = await ev("financial.entry.created", "financial_transaction", tx2.id, { type: "expense" });
    const noContractReconciled = await ev("financial.entry.reconciled", "financial_transaction", tx2.id, { reference: "R2" });
    await drain([created, reconciled, noContractCreated, noContractReconciled], true);
    expect(projectOf.get(created)).toBe(`syn-ent-${runId}`);
    expect(projectOf.get(reconciled)).toBe(projectOf.get(created));
    expect(projectOf.get(noContractCreated)).toBe(fallback.externalKey);
    expect(projectOf.get(noContractReconciled)).toBe(projectOf.get(noContractCreated));
  });

  it("com a flag desligada (padrão), o mapa é ignorado e tudo vai ao projeto padrão", async () => {
    const [a] = await db.insert(resorts).values({ name: `Resort PM-OFF ${runId}` } as never).$returningId();
    await db.insert(financialProjectMap).values({ resortId: a.id, externalKey: `syn-off-${runId}`, name: "Projeto OFF", timezone: "America/Recife" });
    const ev = await contractIn("OFF", a.id);
    await drain([ev], false);
    expect(projectOf.get(ev)).toBe(fallback.externalKey);
  });

  it("API admin: grava com auditoria, recusa fuso inválido e chave com espaço, e remove", async () => {
    const { financialProjectMapRouter } = await import("./routers/financialProjectMap");
    const caller = financialProjectMapRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
    const [r] = await db.insert(resorts).values({ name: `Resort PM-API ${runId}` } as never).$returningId();
    await expect(caller.set({ resortId: r.id, externalKey: "tem espaço", name: "X Y" })).rejects.toThrow();
    await expect(caller.set({ resortId: r.id, externalKey: `k-${runId}`, name: "Projeto API", timezone: "Nao/Existe" })).rejects.toThrow(/Fuso/);
    await caller.set({ resortId: r.id, externalKey: `k-${runId}`, name: "Projeto API" });
    await caller.set({ resortId: r.id, externalKey: `k2-${runId}`, name: "Projeto API 2" }); // upsert
    const listed = (await caller.list()).rows.filter(row => row.resortId === r.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.externalKey).toBe(`k2-${runId}`);
    await caller.remove({ resortId: r.id });
    expect((await caller.list()).rows.filter(row => row.resortId === r.id)).toHaveLength(0);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, r.id));
    expect(audits.filter(a => a.entityType === "financial_project_map").length).toBeGreaterThanOrEqual(3);
  });

  it("a API recusa usuário que não é admin", async () => {
    const { financialProjectMapRouter } = await import("./routers/financialProjectMap");
    const caller = financialProjectMapRouter.createCaller({ user: { id: adminId, role: "user" } } as never);
    await expect(caller.list()).rejects.toThrow();
  });
});
