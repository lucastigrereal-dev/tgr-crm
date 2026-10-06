import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: vi.fn() }));

import { MySqlDialect } from "drizzle-orm/mysql-core";
import { auditLogs, contracts, domainEvents } from "../drizzle/schema";
import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";
import { startFinancialBridgePump } from "./financialBridge";
import { createRetryBackoff, startSalesCancellationBridgePump } from "./relationshipBridge";

// RED TEAM P2: evento com 5xx sem code não pode (a) ser martelado a cada tick nem (b) travar os eventos novos atrás dele.
const mockedGetDb = vi.mocked(getDb);
const mockedRecordAudit = vi.mocked(recordAudit);
const mockedFetch = vi.mocked(fetchWithTimeout);
const dialect = new MySqlDialect();
const project = { externalKey: "22222222-2222-4222-8222-222222222222", name: "SYN", timezone: "America/Recife" };
const respond = (status: number) => new Response("{}", { status, headers: { "Content-Type": "application/json" } });
const clock = { t: 1_000_000 };
const now = () => clock.t;

afterEach(() => { vi.resetAllMocks(); clock.t = 1_000_000; });

describe("createRetryBackoff", () => {
  it("5s dobrando por falha, teto de 10 min; sucesso zera", () => {
    let t = 0;
    const backoff = createRetryBackoff<number, string>(() => t);
    const delays: number[] = [];
    for (let i = 0; i < 12; i += 1) { backoff.fail(1, "e"); delays.push(backoff.nextAt(1)! - t); t = backoff.nextAt(1)!; }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000, 600_000, 600_000]);
    backoff.remove(1);
    backoff.fail(1, "e");
    expect(backoff.nextAt(1)! - t).toBe(5_000);
  });
  it("due() só devolve itens vencidos, mais antigos primeiro", () => {
    let t = 0;
    const backoff = createRetryBackoff<number, string>(() => t);
    backoff.fail(2, "b"); backoff.fail(1, "a");
    expect(backoff.due()).toEqual([]);
    t = 5_000;
    expect(backoff.due()).toEqual(["b", "a"]);
    expect(backoff.scheduled(1)).toBe(true);
  });
});

describe("Financial pump: backoff por evento e sem inanição", () => {
  const mk = (id: number) => ({ id, eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(300 + id), actorUserId: null, payload: JSON.stringify({ status: "active" }), idempotencyKey: null, occurredAt: new Date("2026-10-04T12:00:00.000Z") });
  function fakeDb(events: Array<ReturnType<typeof mk>>) {
    const limits: number[] = [];
    const receipts = () => new Set(mockedRecordAudit.mock.calls.map(call => (call[5] as { idempotencyKey?: string } | undefined)?.idempotencyKey));
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => ({ from: (table: unknown) => {
      let condition: unknown; let limit = 500; let joined = false;
      const q: Record<string, unknown> = {};
      for (const method of ["orderBy"]) q[method] = () => q;
      q.leftJoin = () => { joined = true; return q; };
      q.where = (cond: unknown) => { condition = cond; return q; };
      q.limit = (n: number) => { limit = n; if (table === domainEvents) limits.push(n); return q; };
      q.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
        let rows: unknown[] = [];
        if (table === domainEvents && joined) {
          const cursor = (condition ? dialect.sqlToQuery(condition as never).params.find(param => typeof param === "number") : undefined) as number | undefined;
          const done = receipts();
          rows = events.filter(event => event.id > (cursor ?? 0) && !done.has("financial-event:" + event.id)).slice(0, limit).map(event => ({ event }));
        } else if (table === auditLogs) rows = receipts().has("financial-event:?") ? [{ id: 1 }] : [];
        else if (table === contracts) rows = [];
        return Promise.resolve(rows).then(resolve, reject);
      };
      return q;
    } })) } as never);
    return limits;
  }
  const attempts = (id: number) => mockedFetch.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).event.eventId === id).length;

  it("evento velho preso em 503 é retentado com backoff 5s/10s/20s e não segura o novo", async () => {
    fakeDb([mk(1), mk(2)]);
    mockedRecordAudit.mockResolvedValue(undefined);
    mockedFetch.mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).event.eventId === 1 ? respond(503) : respond(201));
    const pump = startFinancialBridgePump("http://127.0.0.1:3400", "k", project, { autoStart: false, now, onError: vi.fn() });
    try {
      expect(await pump.tick()).toBe(1); // 2 entregue no 1º tick, mesmo com o 1 falhando antes
      expect(attempts(1)).toBe(1);
      await pump.tick(); await pump.tick();
      expect(attempts(1)).toBe(1); // sem martelar: ainda em backoff
      clock.t += 4_999; await pump.tick(); expect(attempts(1)).toBe(1);
      clock.t += 1; await pump.tick(); expect(attempts(1)).toBe(2); // +5s
      clock.t += 9_999; await pump.tick(); expect(attempts(1)).toBe(2);
      clock.t += 1; await pump.tick(); expect(attempts(1)).toBe(3); // +10s
      clock.t += 19_999; await pump.tick(); expect(attempts(1)).toBe(3);
      clock.t += 1; await pump.tick(); expect(attempts(1)).toBe(4); // +20s
      expect(attempts(2)).toBe(1);
    } finally { pump.stop(); }
  });

  it("mais eventos presos que o tamanho do lote não impedem o evento novo (paginação por id)", async () => {
    const events = [mk(1), mk(2), mk(3), mk(4)];
    const limits = fakeDb(events);
    mockedRecordAudit.mockResolvedValue(undefined);
    mockedFetch.mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).event.eventId === 4 ? respond(201) : respond(502));
    const pump = startFinancialBridgePump("http://127.0.0.1:3400", "k", project, { autoStart: false, now, onError: vi.fn(), batchSize: 2 });
    try {
      let delivered = 0;
      for (let i = 0; i < 3; i += 1) delivered += await pump.tick();
      expect(delivered).toBe(1);
      expect(attempts(4)).toBe(1);
      expect(limits.every(limit => limit === 2)).toBe(true);
      expect([1, 2, 3].map(attempts)).toEqual([1, 1, 1]); // cada preso tentado uma vez (backoff), nenhum monopolizou o lote
    } finally { pump.stop(); }
  });

  it("recusa codificada continua terminal na 1ª vez e sai do backoff", async () => {
    fakeDb([mk(1), mk(2)]);
    mockedRecordAudit.mockResolvedValue(undefined);
    mockedFetch.mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).event.eventId === 1 ? new Response(JSON.stringify({ code: "INVALID_CRM_EVENT" }), { status: 422 }) : respond(201));
    const pump = startFinancialBridgePump("http://127.0.0.1:3400", "k", project, { autoStart: false, now, onError: vi.fn() });
    try {
      await pump.tick();
      clock.t += 3_600_000; await pump.tick();
      expect(attempts(1)).toBe(1);
    } finally { pump.stop(); }
  });
});

describe("Sales/Relationship pump: backoff por evento e cursor não fica preso", () => {
  const cancelled = (id: number, contractId: number) => ({ id, eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(contractId), actorUserId: 1, payload: JSON.stringify({ status: "cancelled" }), idempotencyKey: null, occurredAt: new Date("2026-09-26T13:00:00.000Z") });
  const lineageRow = { customerId: 101, customerName: "SYN", customerPhone: null, proposalId: 404, opportunityId: 202, cancellationReason: null };
  const lineageEvent = { payload: JSON.stringify({ saleId: "44444444-4444-4444-4444-444444444444", projectExternalKey: "22222222-2222-2222-2222-222222222222", projectName: "SYN", projectTimezone: "America/Recife", correlationId: "corr-x" }) };
  function fakeDb(events: Array<ReturnType<typeof cancelled>>) {
    const limits: number[] = [];
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => ({ from: (table: unknown) => {
      let condition: unknown; let limit = 500;
      const q: Record<string, unknown> = {};
      for (const method of ["innerJoin", "leftJoin", "orderBy"]) q[method] = () => q;
      q.where = (cond: unknown) => { condition = cond; return q; };
      q.limit = (n: number) => { limit = n; if (table === domainEvents) limits.push(n); return q; };
      q.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
        const cursor = condition ? dialect.sqlToQuery(condition as never).params.find(param => typeof param === "number") : undefined;
        let rows: unknown[] = [];
        if (table === domainEvents && typeof cursor === "number") rows = events.filter(event => event.id > cursor).slice(0, limit);
        else if (table === domainEvents) rows = [lineageEvent];
        else if (table === contracts) rows = [lineageRow];
        else if (table === auditLogs) rows = [];
        return Promise.resolve(rows).then(resolve, reject);
      };
      return q;
    } })) } as never);
    return limits;
  }
  const attempts = (contractId: string) => mockedFetch.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).contractId === contractId).length;

  it("evento preso (503) não segura o cursor: o novo chega no tick seguinte e o preso volta só quando o backoff vence", async () => {
    const limits = fakeDb([cancelled(90, 303), cancelled(91, 304)]);
    mockedRecordAudit.mockResolvedValue(undefined);
    mockedFetch.mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).contractId === "303" ? respond(503) : respond(201));
    const pump = startSalesCancellationBridgePump("http://127.0.0.1:3100", "k", { autoStart: false, now, onError: vi.fn(), batchSize: 1 });
    try {
      expect(await pump.tick()).toBe(0); // lote de 1: só o 90, que falha
      expect(await pump.tick()).toBe(1); // 91 entregue apesar do 90 preso
      expect(attempts("303")).toBe(1);
      await pump.tick(); await pump.tick();
      expect(attempts("303")).toBe(1);
      clock.t += 5_000; await pump.tick(); expect(attempts("303")).toBe(2);
      clock.t += 9_999; await pump.tick(); expect(attempts("303")).toBe(2);
      clock.t += 1; await pump.tick(); expect(attempts("303")).toBe(3);
      expect(attempts("304")).toBe(1);
      expect(limits.every(limit => limit === 1)).toBe(true);
    } finally { pump.stop(); }
  });
});
