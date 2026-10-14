import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, domainEvents } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Outbox na transação em MySQL REAL: o evento ganha o id no INSERT e só aparece no COMMIT. Uma transação longa (distrato,
// baixa) pode commitar um evento de id MENOR depois que as pontes já passaram o cursor por ids maiores. Sem a releitura de
// recentes, esse evento só era entregue depois de reiniciar o CRM.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("pontes em MySQL real: evento de commit tardio (id menor que o cursor) é entregue sem reiniciar", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let server: Server;
  let baseUrl = "";
  const hits = new Map<number, number>();

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const eventId = Number(JSON.parse(raw).event?.eventId);
        if (Number.isFinite(eventId)) hits.set(eventId, (hits.get(eventId) ?? 0) + 1);
        res.writeHead(201, { "Content-Type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise(resolve => server?.close(resolve));
    await pool?.end();
  });

  const salesReceipt = (contractId: number) => db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "contract"), eq(auditLogs.idempotencyKey, `sales-contract:${contractId}:cancelled`)));

  it("Financial e cancelamento ao Sales: o evento da transação que commita depois é entregue no tick seguinte, uma vez só", async () => {
    const { startFinancialBridgePump } = await import("./financialBridge");
    const { startSalesCancellationBridgePump } = await import("./relationshipBridge");
    const lateContract = 970_000_000 + Math.floor(Math.random() * 1_000_000);
    const earlyContract = lateContract + 1;

    // Transação A (ainda aberta) reserva o id menor.
    const conn = await pool.getConnection();
    let lateId = 0;
    try {
      await conn.beginTransaction();
      const [result] = await conn.query<mysql.ResultSetHeader>("INSERT INTO domain_events (eventName, aggregateType, aggregateId, payload) VALUES ('contract.status.updated', 'contract', ?, ?)", [String(lateContract), JSON.stringify({ status: "cancelled", cancellationReason: `late ${runId}` })]);
      lateId = result.insertId;
      // Transação B commita um id maior.
      const [early] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(earlyContract), actorUserId: null, payload: JSON.stringify({ status: "cancelled", cancellationReason: `early ${runId}` }) }).$returningId();
      expect(early.id).toBeGreaterThan(lateId);

      const financial = startFinancialBridgePump(baseUrl, "syn-fin-key", { externalKey: randomUUID(), name: `SYN late ${runId}`, timezone: "America/Recife" }, { autoStart: false, onError: () => undefined });
      const sales = startSalesCancellationBridgePump(baseUrl, "syn-sales-key", { autoStart: false, onError: () => undefined });
      try {
        // Drena até o evento de B ser tratado pelas duas pontes (o cursor passa do id de A, ainda invisível).
        for (let i = 0; i < 50 && (!hits.get(early.id) || !(await salesReceipt(earlyContract)).length); i += 1) { await financial.tick(); await sales.tick(); }
        expect(hits.get(early.id)).toBe(1);
        expect(await salesReceipt(earlyContract)).toHaveLength(1);
        expect(hits.get(lateId)).toBeUndefined();
        expect(await salesReceipt(lateContract)).toHaveLength(0);

        await conn.commit();
        await financial.tick();
        await sales.tick();
        // Sem a releitura de recentes, nenhum dos dois acontecia antes de reiniciar o processo.
        expect(hits.get(lateId)).toBe(1);
        expect(await salesReceipt(lateContract)).toHaveLength(1);

        // Reler é seguro: nada é entregue duas vezes.
        for (let i = 0; i < 3; i += 1) { await financial.tick(); await sales.tick(); }
        expect(hits.get(lateId)).toBe(1);
        expect(hits.get(early.id)).toBe(1);
        expect(await salesReceipt(lateContract)).toHaveLength(1);
      } finally { financial.stop(); sales.stop(); }
    } finally {
      await conn.rollback().catch(() => undefined);
      conn.release();
    }
  });
});
