import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { domainEvents } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// RED TEAM P2 em MySQL real: eventos antigos presos em 503 (sem code) não escondem o evento novo, mesmo com mais presos
// que o tamanho do lote, e são retentados com backoff (não a cada tick).
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("Financial pump em MySQL real: sem inanição e com backoff", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let server: Server;
  let baseUrl = "";
  const stuck = new Set<number>();
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
        const eventId = Number(JSON.parse(raw).event.eventId);
        hits.set(eventId, (hits.get(eventId) ?? 0) + 1);
        res.writeHead(stuck.has(eventId) ? 503 : 201, { "Content-Type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise(resolve => server?.close(resolve));
    await pool?.end();
  });

  it("3 eventos presos com lote de 2 não impedem o evento novo; retry só quando o backoff vence", async () => {
    const { startFinancialBridgePump, FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    const mk = (n: number) => ({ eventName: "contract.status.updated" as const, aggregateType: "contract", aggregateId: String(950_000_000 + n), actorUserId: null, payload: JSON.stringify({ status: "active" }), occurredAt: new Date() });
    const ids: number[] = [];
    for (let n = 0; n < 4; n += 1) { const [row] = await db.insert(domainEvents).values(mk(n)).$returningId(); ids.push(row.id); }
    ids.slice(0, 3).forEach(id => stuck.add(id));
    const newId = ids[3]!;
    const clock = { t: 5_000_000 };
    const pump = startFinancialBridgePump(baseUrl, "syn-fin-key", { externalKey: randomUUID(), name: `SYN starvation ${runId}`, timezone: "America/Recife" }, { autoStart: false, now: () => clock.t, batchSize: 2, onError: () => undefined });
    try {
      // Varre a fila (eventos de outros testes no mesmo banco também passam, todos com 201) até o novo ser entregue.
      // O limite vem do backlog real sem recibo até o evento novo: um limite fixo reprovava (flake) quando outros testes MySQL deixavam >800 eventos pendentes no mesmo banco.
      const placeholders = FINANCIAL_EVENT_NAMES.map(() => "?").join(",");
      const [backlogRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS pending FROM domain_events d LEFT JOIN audit_logs a ON a.idempotencyKey = CONCAT('financial-event:', d.id) WHERE a.id IS NULL AND d.id <= ? AND d.eventName IN (${placeholders})`,
        [newId, ...FINANCIAL_EVENT_NAMES],
      );
      const maxTicks = Math.ceil(Number(backlogRows[0]?.pending ?? 0) / 2) + 20;
      for (let i = 0; i < maxTicks && !hits.get(newId); i += 1) await pump.tick();
      expect(hits.get(newId)).toBe(1);
      for (const id of ids.slice(0, 3)) expect(hits.get(id)).toBe(1); // cada preso tentado uma única vez até aqui
      for (let i = 0; i < 3; i += 1) await pump.tick();
      for (const id of ids.slice(0, 3)) expect(hits.get(id)).toBe(1); // sem martelar
      clock.t += 5_000;
      await pump.tick();
      for (const id of ids.slice(0, 3)) expect(hits.get(id)).toBe(2); // +5s: retry
      expect(hits.get(newId)).toBe(1); // entregue: recibo, não volta
    } finally { pump.stop(); }
  });
  // Outbox na transação: o id nasce no INSERT e só aparece no COMMIT; uma transação longa (distrato, baixa) pode commitar um id
  // MENOR depois que o cursor passou por ids maiores. Sem a releitura de recentes, o evento só ia ao Financial após reiniciar.
  // (Fica neste arquivo de propósito: um único pump do Financial por vez no banco compartilhado.)
  it("commit tardio: evento com id menor que o cursor é entregue sem reiniciar, uma vez só", async () => {
    const { startFinancialBridgePump } = await import("./financialBridge");
    const aggregate = 990_000_000 + Math.floor(Math.random() * 1_000_000);
    const conn = await pool.getConnection();
    // Espera de lock limitada: com DDL de trigger de outro arquivo na fila, falha em 10 s com erro claro em vez de travar até o timeout do vitest.
    await conn.query("SET SESSION lock_wait_timeout = 10");
    // Limite de ticks pelo tamanho real da fila (a ponte começa do cursor 0 e o banco do CI pode estar sujo de rodadas anteriores).
    const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM domain_events") as unknown as [[{ total: number }]];
    const maxTicks = Math.ceil((Number(total) + 600) / 500) + 10;
    const pump = startFinancialBridgePump(baseUrl, "syn-fin-key", { externalKey: randomUUID(), name: `SYN late ${runId}`, timezone: "America/Recife" }, { autoStart: false, onError: () => undefined });
    try {
      await conn.beginTransaction();
      const [result] = await conn.query<mysql.ResultSetHeader>("INSERT INTO domain_events (eventName, aggregateType, aggregateId, payload) VALUES ('contract.status.updated', 'contract', ?, ?)", [String(aggregate), JSON.stringify({ status: "cancelled" })]);
      const lateId = result.insertId;
      const [early] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate + 1), actorUserId: null, payload: JSON.stringify({ status: "cancelled" }) }).$returningId();
      expect(early.id).toBeGreaterThan(lateId);
      for (let i = 0; i < maxTicks && !hits.get(early.id); i += 1) await pump.tick();
      expect(hits.get(early.id)).toBe(1); // cursor já passou do id da transação aberta
      expect(hits.get(lateId)).toBeUndefined();

      await conn.commit();
      for (let i = 0; i < maxTicks && !hits.get(lateId); i += 1) await pump.tick();
      expect(hits.get(lateId)).toBe(1);
      for (let i = 0; i < 3; i += 1) await pump.tick();
      expect(hits.get(lateId)).toBe(1);
      expect(hits.get(early.id)).toBe(1);
    } finally {
      pump.stop();
      await conn.rollback().catch(() => undefined);
      conn.release();
    }
  });
});
