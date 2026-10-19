import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, domainEvents, users } from "../drizzle/schema";
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
  const seen: number[] = [];

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
        seen.push(eventId);
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
  // Codex P1: eventos em backoff abaixo do cursor, em número >= lote, não podem esconder o evento de commit tardio da releitura.
  it("commit tardio com fila de retry maior que o lote: o evento tardio ainda é entregue", async () => {
    const { startFinancialBridgePump, FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    const aggregate = 980_000_000 + Math.floor(Math.random() * 1_000_000);
    const conn = await pool.getConnection();
    await conn.query("SET SESSION lock_wait_timeout = 10");
    const clock = { t: 9_000_000 }; // relógio parado: ninguém sai do backoff durante o teste
    const pump = startFinancialBridgePump(baseUrl, "syn-fin-key", { externalKey: randomUUID(), name: `SYN late retry ${runId}`, timezone: "America/Recife" }, { autoStart: false, now: () => clock.t, batchSize: 2, onError: () => undefined });
    try {
      // Limite pelo backlog real sem recibo (lote de 2): o banco compartilhado tem pendentes de outros testes.
      const placeholders = FINANCIAL_EVENT_NAMES.map(() => "?").join(",");
      const [backlogRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS pending FROM domain_events d LEFT JOIN audit_logs a ON a.idempotencyKey = CONCAT('financial-event:', d.id) WHERE a.id IS NULL AND d.eventName IN (${placeholders})`,
        [...FINANCIAL_EVENT_NAMES],
      );
      // Folga para os ~500 eventos que contractBridgeCursor grava em paralelo (também sem recibo do Financial); tick vazio é barato.
      const maxTicks = Math.ceil((Number(backlogRows[0]?.pending ?? 0) + 2000) / 2) + 20;
      // Drena o backlog ANTES de abrir a transação: segurar o INSERT aberto por muitos ticks enfileira o DDL de trigger de outro
      // arquivo (metadata lock) e trava a suíte inteira.
      const [marker] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate + 9), actorUserId: null, payload: JSON.stringify({ status: "active" }) }).$returningId();
      for (let i = 0; i < maxTicks && !hits.get(marker.id); i += 1) await pump.tick();
      expect(hits.get(marker.id)).toBe(1);
      await conn.beginTransaction();
      const [result] = await conn.query<mysql.ResultSetHeader>("INSERT INTO domain_events (eventName, aggregateType, aggregateId, payload) VALUES ('contract.status.updated', 'contract', ?, ?)", [String(aggregate), JSON.stringify({ status: "cancelled" })]);
      const lateId = result.insertId;
      const stuckIds: number[] = [];
      for (let n = 1; n <= 3; n += 1) {
        const [row] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate + n), actorUserId: null, payload: JSON.stringify({ status: "cancelled" }) }).$returningId();
        stuck.add(row.id);
        stuckIds.push(row.id);
      }
      const last = stuckIds[stuckIds.length - 1]!;
      for (let i = 0; i < maxTicks && !hits.get(last); i += 1) await pump.tick();
      for (const id of stuckIds) expect(hits.get(id)).toBe(1); // os 3 em backoff, todos acima do id da transação aberta

      await conn.commit();
      for (let i = 0; i < maxTicks && !hits.get(lateId); i += 1) await pump.tick();
      expect(hits.get(lateId)).toBe(1);
      for (const id of stuckIds) expect(hits.get(id)).toBe(1); // backoff respeitado
    } finally {
      pump.stop();
      await conn.rollback().catch(() => undefined);
      conn.release();
    }
  });
  // Codex P2: uma transação tardia com mais eventos que o lote (distrato com muitas comissões) sai em ordem de id, do mais velho.
  it("commit tardio com mais eventos que o lote e um evento novo do mesmo contrato: entregues em ordem de id", async () => {
    const { startFinancialBridgePump, FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    const aggregate = 970_000_000 + Math.floor(Math.random() * 1_000_000);
    const conn = await pool.getConnection();
    await conn.query("SET SESSION lock_wait_timeout = 10");
    const pump = startFinancialBridgePump(baseUrl, "syn-fin-key", { externalKey: randomUUID(), name: `SYN late order ${runId}`, timezone: "America/Recife" }, { autoStart: false, batchSize: 2, onError: () => undefined });
    try {
      const placeholders = FINANCIAL_EVENT_NAMES.map(() => "?").join(",");
      const [backlogRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS pending FROM domain_events d LEFT JOIN audit_logs a ON a.idempotencyKey = CONCAT('financial-event:', d.id) WHERE a.id IS NULL AND d.eventName IN (${placeholders})`,
        [...FINANCIAL_EVENT_NAMES],
      );
      const maxTicks = Math.ceil((Number(backlogRows[0]?.pending ?? 0) + 2000) / 2) + 20;
      // Backlog drenado antes de abrir a transação (ver o teste anterior).
      const [marker] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate + 9), actorUserId: null, payload: JSON.stringify({ status: "active" }) }).$returningId();
      for (let i = 0; i < maxTicks && !hits.get(marker.id); i += 1) await pump.tick();
      expect(hits.get(marker.id)).toBe(1);

      await conn.beginTransaction();
      const lateIds: number[] = [];
      for (const status of ["cancelled", "cancelled", "cancelled"]) {
        const [result] = await conn.query<mysql.ResultSetHeader>("INSERT INTO domain_events (eventName, aggregateType, aggregateId, payload) VALUES ('contract.status.updated', 'contract', ?, ?)", [String(aggregate), JSON.stringify({ status })]);
        lateIds.push(result.insertId);
      }
      const [early] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate + 1), actorUserId: null, payload: JSON.stringify({ status: "active" }) }).$returningId();
      for (let i = 0; i < maxTicks && !hits.get(early.id); i += 1) await pump.tick();
      expect(hits.get(early.id)).toBe(1); // cursor passou dos ids da transação aberta

      await conn.commit();
      // Evento NOVO do mesmo contrato, acima do cursor, visível junto com os tardios: não pode passar na frente deles (Codex P2).
      const [newer] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate), actorUserId: null, payload: JSON.stringify({ status: "cancelled" }) }).$returningId();
      const all = [...lateIds, newer.id];
      for (let i = 0; i < maxTicks && !all.every(id => hits.get(id)); i += 1) await pump.tick();
      for (const id of all) expect(hits.get(id)).toBe(1);
      expect(seen.filter(id => all.includes(id))).toEqual(all); // do mais velho para o mais novo, o novo por último
    } finally {
      pump.stop();
      await conn.rollback().catch(() => undefined);
      conn.release();
    }
  });
  // Codex P2: retry além do teto de exclusão não pode ocupar todo lote relido; a releitura pagina e o tardio chega.
  it("commit tardio com cauda de retry além do teto: releitura paginada entrega o tardio", async () => {
    const { startFinancialBridgePump, FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    const aggregate = 960_000_000 + Math.floor(Math.random() * 1_000_000);
    const conn = await pool.getConnection();
    await conn.query("SET SESSION lock_wait_timeout = 10");
    const clock = { t: 13_000_000 }; // relógio parado: ninguém sai do backoff
    // Teto 1 e lote 2: com 4 em retry acima do tardio, sobram 3 não excluídos, mais que o lote.
    const pump = startFinancialBridgePump(baseUrl, "syn-fin-key", { externalKey: randomUUID(), name: `SYN late page ${runId}`, timezone: "America/Recife" }, { autoStart: false, now: () => clock.t, batchSize: 2, retryExclusionCap: 1, onError: () => undefined });
    try {
      const placeholders = FINANCIAL_EVENT_NAMES.map(() => "?").join(",");
      const [backlogRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS pending FROM domain_events d LEFT JOIN audit_logs a ON a.idempotencyKey = CONCAT('financial-event:', d.id) WHERE a.id IS NULL AND d.eventName IN (${placeholders})`,
        [...FINANCIAL_EVENT_NAMES],
      );
      const maxTicks = Math.ceil((Number(backlogRows[0]?.pending ?? 0) + 2000) / 2) + 20;
      const [marker] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate + 9), actorUserId: null, payload: JSON.stringify({ status: "active" }) }).$returningId();
      for (let i = 0; i < maxTicks && !hits.get(marker.id); i += 1) await pump.tick();
      expect(hits.get(marker.id)).toBe(1);

      await conn.beginTransaction();
      const [result] = await conn.query<mysql.ResultSetHeader>("INSERT INTO domain_events (eventName, aggregateType, aggregateId, payload) VALUES ('contract.status.updated', 'contract', ?, ?)", [String(aggregate), JSON.stringify({ status: "cancelled" })]);
      const lateId = result.insertId;
      const stuckIds: number[] = [];
      for (let n = 1; n <= 4; n += 1) {
        const [row] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate + n), actorUserId: null, payload: JSON.stringify({ status: "cancelled" }) }).$returningId();
        stuck.add(row.id);
        stuckIds.push(row.id);
      }
      const last = stuckIds[stuckIds.length - 1]!;
      for (let i = 0; i < maxTicks && !hits.get(last); i += 1) await pump.tick();
      for (const id of stuckIds) expect(hits.get(id)).toBe(1);

      await conn.commit();
      for (let i = 0; i < maxTicks && !hits.get(lateId); i += 1) await pump.tick();
      expect(hits.get(lateId)).toBe(1);
      for (const id of stuckIds) expect(hits.get(id)).toBe(1); // backoff respeitado
    } finally {
      pump.stop();
      await conn.rollback().catch(() => undefined);
      conn.release();
    }
  });
  // Codex P2: um retry vencido de id maior não passa na frente do evento tardio mais velho do mesmo contrato no mesmo tick.
  it("commit tardio e retry vencido do mesmo contrato no mesmo tick: o mais velho vai primeiro", async () => {
    const { startFinancialBridgePump, FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    const aggregate = 950_500_000 + Math.floor(Math.random() * 1_000_000);
    const conn = await pool.getConnection();
    await conn.query("SET SESSION lock_wait_timeout = 10");
    const clock = { t: 17_000_000 };
    const pump = startFinancialBridgePump(baseUrl, "syn-fin-key", { externalKey: randomUUID(), name: `SYN late due ${runId}`, timezone: "America/Recife" }, { autoStart: false, now: () => clock.t, onError: () => undefined });
    try {
      const placeholders = FINANCIAL_EVENT_NAMES.map(() => "?").join(",");
      const [backlogRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS pending FROM domain_events d LEFT JOIN audit_logs a ON a.idempotencyKey = CONCAT('financial-event:', d.id) WHERE a.id IS NULL AND d.eventName IN (${placeholders})`,
        [...FINANCIAL_EVENT_NAMES],
      );
      const maxTicks = Math.ceil((Number(backlogRows[0]?.pending ?? 0) + 2000) / 500) + 20;
      const [marker] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate + 9), actorUserId: null, payload: JSON.stringify({ status: "active" }) }).$returningId();
      for (let i = 0; i < maxTicks && !hits.get(marker.id); i += 1) await pump.tick();
      expect(hits.get(marker.id)).toBe(1);

      await conn.beginTransaction();
      const [result] = await conn.query<mysql.ResultSetHeader>("INSERT INTO domain_events (eventName, aggregateType, aggregateId, payload) VALUES ('contract.status.updated', 'contract', ?, ?)", [String(aggregate), JSON.stringify({ status: "active" })]);
      const lateId = result.insertId;
      const [newer] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(aggregate), actorUserId: null, payload: JSON.stringify({ status: "cancelled" }) }).$returningId();
      stuck.add(newer.id);
      for (let i = 0; i < maxTicks && !hits.get(newer.id); i += 1) await pump.tick();
      expect(hits.get(newer.id)).toBe(1); // tentado e foi para o retry

      await conn.commit();
      stuck.delete(newer.id); // o consumidor voltou
      clock.t += 5_000; // o retry vence no mesmo tick em que o tardio aparece
      for (let i = 0; i < maxTicks && !(hits.get(lateId) && hits.get(newer.id) === 2); i += 1) await pump.tick();
      expect(seen.filter(id => id === lateId || id === newer.id)).toEqual([newer.id, lateId, newer.id]);
    } finally {
      pump.stop();
      await conn.rollback().catch(() => undefined);
      conn.release();
    }
  });

  // CRM-A25: "reenviar" um recusado ANTIGO (fora da janela de releitura, abaixo do cursor) faz a ponte relê-lo sem reiniciar, e a recusa fica na trilha.
  it("reenviar recusado antigo: a chave do recibo é trocada (recusa fica na trilha), a ponte recua o cursor e entrega uma vez", async () => {
    const { startFinancialBridgePump, FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    const { resendRejectedReceipt } = await import("./integrationResend");
    const { getDb } = await import("./db");
    const old = new Date(Date.now() - 3 * 3_600_000);
    const [oldEvent] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(970_000_000 + Math.floor(Math.random() * 1_000_000)), actorUserId: null, payload: JSON.stringify({ status: "active" }), occurredAt: old }).$returningId();
    const [receipt] = await db.insert(auditLogs).values({ actorUserId: null, entityType: "integration_event", entityId: String(oldEvent.id), action: "financial_rejected", summary: "recusa sintética", idempotencyKey: `financial-event:${oldEvent.id}` }).$returningId();
    const [marker] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(960_000_000 + Math.floor(Math.random() * 1_000_000)), actorUserId: null, payload: JSON.stringify({ status: "active" }) }).$returningId();
    const placeholders = FINANCIAL_EVENT_NAMES.map(() => "?").join(",");
    const [backlogRows] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS pending FROM domain_events d LEFT JOIN audit_logs a ON a.idempotencyKey = CONCAT('financial-event:', d.id) WHERE a.id IS NULL AND d.eventName IN (${placeholders})`, [...FINANCIAL_EVENT_NAMES]);
    const maxTicks = Math.ceil((Number(backlogRows[0]?.pending ?? 0) + 2000) / 500) + 20;
    const pump = startFinancialBridgePump(baseUrl, "syn-fin-key", { externalKey: randomUUID(), name: `SYN resend ${runId}`, timezone: "America/Recife" }, { autoStart: false, onError: () => undefined });
    try {
      for (let i = 0; i < maxTicks && !hits.get(marker.id); i += 1) await pump.tick();
      expect(hits.get(marker.id)).toBe(1); // cursor já passou do evento antigo
      for (let i = 0; i < 3; i += 1) await pump.tick();
      expect(hits.get(oldEvent.id)).toBeUndefined(); // tem recibo de recusa: a ponte não o tenta

      const appDb = await getDb();
      // usuário próprio: o id 1 só existe se outro arquivo de teste já tiver rodado (FK de audit_logs), o que depende da ordem entre processos
      const [{ id: actorUserId }] = await db.insert(users).values({ openId: `resend-actor-${runId}`, name: "Operador reenvio", role: "admin" }).$returningId();
      const result = await resendRejectedReceipt(appDb!, { receiptId: receipt.id, actorUserId });
      expect(result).toEqual({ bridge: "financial", rewindTo: oldEvent.id });
      await expect(resendRejectedReceipt(appDb!, { receiptId: receipt.id, actorUserId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); // duplo clique
      const [kept] = await db.select().from(auditLogs).where(eq(auditLogs.id, receipt.id));
      expect(kept).toMatchObject({ action: "financial_rejected", summary: "recusa sintética", idempotencyKey: `resent:${receipt.id}:financial-event:${oldEvent.id}` });
      expect((await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `resend-request:${receipt.id}`))).length).toBe(1);

      for (let i = 0; i < maxTicks && !hits.get(oldEvent.id); i += 1) await pump.tick();
      expect(hits.get(oldEvent.id)).toBe(1);
      for (let i = 0; i < 3; i += 1) await pump.tick();
      expect(hits.get(oldEvent.id)).toBe(1); // entregue: ganhou recibo novo, não volta
      expect(hits.get(marker.id)).toBe(1);
    } finally { pump.stop(); }
  });
});
