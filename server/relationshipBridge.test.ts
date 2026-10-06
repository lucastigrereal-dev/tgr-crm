import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: vi.fn() }));

import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { auditLogs, contracts, domainEvents } from "../drizzle/schema";
import { buildContractStateBody, createRejectionTracker, DeliveryRejectedError, startRelationshipBridgePump, startSalesCancellationBridgePump } from "./relationshipBridge";

const mockedGetDb = vi.mocked(getDb);
const mockedRecordAudit = vi.mocked(recordAudit);
const mockedFetch = vi.mocked(fetchWithTimeout);

// Backoff por evento (RED TEAM P2): cada tick de teste avança o relógio além do teto (10 min), então todo evento em retry está vencido.
const pumpClock = { t: 0 };
function eagerPump<P extends { tick(): Promise<number>; stop(): void }>(start: (...args: any[]) => P, ...args: any[]): P {
  const last = args.length - 1;
  const pump = start(...args.slice(0, last), { ...args[last], now: () => pumpClock.t });
  return { ...pump, tick: async () => { pumpClock.t += 11 * 60_000; return pump.tick(); } };
}

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
  for (const method of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) promise[method] = () => promise;
  return promise;
}

describe("CRM to Relationship bridge", () => {
  afterEach(() => vi.resetAllMocks());

  it("requires TLS outside loopback", () => {
    expect(() => eagerPump(startRelationshipBridgePump, "http://relationship.internal:3200", "relationship-key", { autoStart: false }))
      .toThrow("Relationship endpoint requires TLS outside loopback");
    expect(() => eagerPump(startRelationshipBridgePump, "https://relationship.example.invalid", "relationship-key", { autoStart: false }))
      .not.toThrow();
  });

  it("delivers an activated bridged contract exactly once per audit receipt", async () => {
    const event = {
      id: 77,
      eventName: "contract.status.updated",
      aggregateType: "contract",
      aggregateId: "303",
      actorUserId: 1,
      payload: JSON.stringify({ status: "active" }),
      idempotencyKey: null,
      occurredAt: new Date("2026-09-25T13:00:00.000Z"),
    };
    const sequence: unknown[] = [
      [event],
      [],
      [{
        customerId: 101,
        customerName: "Ana & Bruno",
        customerPhone: "84999990000",
        proposalId: 404,
        opportunityId: 202,
        cancellationReason: null,
      }],
      [{
        payload: JSON.stringify({
          customerId: 101,
          saleId: "44444444-4444-4444-4444-444444444444",
          encounterId: "55555555-5555-5555-5555-555555555555",
          projectExternalKey: "22222222-2222-2222-2222-222222222222",
          projectName: "SYN Resort Laboratório",
          projectTimezone: "America/Recife",
          correlationId: "corr-crm-rel-001",
        }),
      }],
      [event],
      [{ id: 909 }],
    ];
    let selectIndex = 0;
    mockedGetDb.mockResolvedValue({
      select: vi.fn(() => chain(sequence[selectIndex++] ?? [])),
    } as never);
    mockedFetch.mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 201 }));
    mockedRecordAudit.mockResolvedValue(undefined);

    const pump = eagerPump(startRelationshipBridgePump, "http://127.0.0.1:3200", "relationship-key", { autoStart: false });
    try {
      expect(await pump.tick()).toBe(1);
      expect(await pump.tick()).toBe(0);
    } finally {
      pump.stop();
    }

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [target, init] = mockedFetch.mock.calls[0]!;
    expect(String(target)).toBe("http://127.0.0.1:3200/api/integration/events");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer relationship-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      eventId: "crm-contract-303-active",
      eventName: "crm.contract.activated.v1",
      source: "crm",
      correlationId: "corr-crm-rel-001",
      project: {
        externalKey: "22222222-2222-2222-2222-222222222222",
        name: "SYN Resort Laboratório",
        timezone: "America/Recife",
      },
      saleId: "44444444-4444-4444-4444-444444444444",
      customerId: "101",
      contractId: "303",
      customer: { name: "Ana & Bruno", phone: "84999990000" },
    });
    expect(mockedRecordAudit).toHaveBeenCalledWith(
      null,
      "contract",
      303,
      "relationship_delivered",
      "crm.contract.activated.v1 entregue ao TGR Relationship.",
      { idempotencyKey: "relationship-contract:303:active" },
    );
  });
  it("delivers only cancellations to Sales Command, at its CRM intake path, with its own receipt", async () => {
    const activated = { id: 80, eventName: "contract.status.updated", aggregateType: "contract", aggregateId: "303", actorUserId: 1,
      payload: JSON.stringify({ status: "active" }), idempotencyKey: null, occurredAt: new Date("2026-09-25T13:00:00.000Z") };
    const cancelled = { ...activated, id: 81, payload: JSON.stringify({ status: "cancelled" }), occurredAt: new Date("2026-09-26T13:00:00.000Z") };
    const sequence: unknown[] = [
      [activated, cancelled],
      [],
      [{ customerId: 101, customerName: "Ana & Bruno", customerPhone: null, proposalId: 404, opportunityId: 202, cancellationReason: "Distrato SYN" }],
      [{ payload: JSON.stringify({ saleId: "44444444-4444-4444-4444-444444444444", projectExternalKey: "22222222-2222-2222-2222-222222222222",
        projectName: "SYN Resort Laboratório", projectTimezone: "America/Recife", correlationId: "corr-crm-sales-001" }) }],
    ];
    let selectIndex = 0;
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => chain(sequence[selectIndex++] ?? [])) } as never);
    mockedFetch.mockResolvedValue(new Response("{}", { status: 201 }));
    mockedRecordAudit.mockResolvedValue(undefined);

    const pump = eagerPump(startSalesCancellationBridgePump, "http://127.0.0.1:3100", "sales-cancel-key", { autoStart: false });
    try {
      expect(await pump.tick()).toBe(1);
    } finally {
      pump.stop();
    }
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [target, init] = mockedFetch.mock.calls[0]!;
    expect(String(target)).toBe("http://127.0.0.1:3100/api/integration/crm/events");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sales-cancel-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      eventId: "crm-contract-303-cancelled",
      eventName: "crm.contract.cancelled.v1",
      saleId: "44444444-4444-4444-4444-444444444444",
      contractId: "303",
      closureReason: "Distrato SYN",
    });
    expect(mockedRecordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_cancellation_delivered",
      "crm.contract.cancelled.v1 entregue ao TGR Sales Command.", { idempotencyKey: "sales-contract:303:cancelled" });
  });

  it("requires TLS for the Sales Command endpoint outside loopback", () => {
    expect(() => eagerPump(startSalesCancellationBridgePump, "http://sales.internal:3100", "k", { autoStart: false }))
      .toThrow("Sales Command endpoint requires TLS outside loopback");
  });
  function cancellationDb() {
    const cancelled = { id: 90, eventName: "contract.status.updated", aggregateType: "contract", aggregateId: "303", actorUserId: 1,
      payload: JSON.stringify({ status: "cancelled" }), idempotencyKey: null, occurredAt: new Date("2026-09-26T13:00:00.000Z") };
    const sequence: unknown[] = [
      [cancelled], [],
      [{ customerId: 101, customerName: "SYN", customerPhone: null, proposalId: 404, opportunityId: 202, cancellationReason: null }],
      [{ payload: JSON.stringify({ saleId: "44444444-4444-4444-4444-444444444444", projectExternalKey: "22222222-2222-2222-2222-222222222222",
        projectName: "SYN", projectTimezone: "America/Recife", correlationId: "corr-x" }) }],
    ];
    let selectIndex = 0; // leituras posicionais repetidas a cada tick (o teste avança o relógio para o backoff vencer)
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => chain(sequence[selectIndex++ % sequence.length])) } as never);
  }

  it("writes a terminal receipt only after repeated content rejections (409), so one poison event cannot pin the queue", async () => {
    cancellationDb();
    mockedFetch.mockImplementation(async () => new Response("{}", { status: 409 }));
    mockedRecordAudit.mockResolvedValue(undefined);
    const onError = vi.fn();
    const pump = eagerPump(startSalesCancellationBridgePump, "http://127.0.0.1:3100", "k", { autoStart: false, onError, rejectionWindowMs: 0 });
    try {
      for (let i = 1; i < 5; i += 1) await pump.tick();
      expect(mockedRecordAudit).not.toHaveBeenCalled();
      await pump.tick();
    } finally { pump.stop(); }
    expect(mockedRecordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_cancellation_rejected",
      "crm.contract.cancelled.v1 recusado pelo TGR Sales Command 5x seguidas (HTTP 409).", { idempotencyKey: "sales-contract:303:cancelled" });
    expect(onError).toHaveBeenCalledTimes(5);
    const body = JSON.parse(String(mockedFetch.mock.calls[0]![1]?.body));
    expect(body).not.toHaveProperty("customer");
  });

  it("never drops events on wrong key, missing route or transient errors (401/404/503)", async () => {
    for (const status of [401, 404, 503]) {
      vi.resetAllMocks();
      cancellationDb();
      mockedFetch.mockImplementation(async () => new Response("{}", { status }));
      const onError = vi.fn();
      const pump = eagerPump(startSalesCancellationBridgePump, "http://127.0.0.1:3100", "k", { autoStart: false, onError, rejectionWindowMs: 0 });
      try { for (let i = 0; i < 8; i += 1) expect(await pump.tick()).toBe(0); } finally { pump.stop(); }
      expect(mockedRecordAudit).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(8);
    }
  });

  it("never rejects the tick when the database fails outside delivery", async () => {
    mockedGetDb.mockRejectedValue(new Error("db down"));
    const onError = vi.fn();
    const pump = eagerPump(startRelationshipBridgePump, "http://127.0.0.1:3200", "k", { autoStart: false, onError });
    try { await expect(pump.tick()).resolves.toBe(0); } finally { pump.stop(); }
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("needs 5 consecutive content rejections AND the minimum window before giving up", () => {
    let now = 0;
    const tracker = createRejectionTracker<string>(600_000, () => now);
    const conflict = new DeliveryRejectedError("Sales Command", 409);
    for (let i = 0; i < 6; i += 1) expect(tracker.record("k", conflict)).toBe(false);
    now = 600_000;
    expect(tracker.record("k", conflict)).toBe(true);
  });

  it("resets the count on any non-content failure, so rejections must really be consecutive", () => {
    const tracker = createRejectionTracker<string>(0);
    const bad = new DeliveryRejectedError("Financial", 400);
    for (let i = 0; i < 4; i += 1) expect(tracker.record("k", bad)).toBe(false);
    expect(tracker.record("k", new DeliveryRejectedError("Financial", 503))).toBe(false);
    for (let i = 0; i < 4; i += 1) expect(tracker.record("k", bad)).toBe(false);
    expect(tracker.record("k", bad)).toBe(true);
  });

  // ---- revisão KAN-31 (PIL-008): recusa de conteúdo com `code` é terminal na 1ª vez e não trava a fila
  describe("recusa codificada (PIL-008)", () => {
    const dialect = new MySqlDialect();
    const lineageRow = { customerId: 101, customerName: "SYN", customerPhone: null, proposalId: 404, opportunityId: 202, cancellationReason: null };
    const lineageEvent = { payload: JSON.stringify({ saleId: "44444444-4444-4444-4444-444444444444", projectExternalKey: "22222222-2222-2222-2222-222222222222", projectName: "SYN", projectTimezone: "America/Recife", correlationId: "corr-x" }) };
    const cancelledEvent = (id: number, contractId: number) => ({ id, eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(contractId), actorUserId: 1, payload: JSON.stringify({ status: "cancelled" }), idempotencyKey: null, occurredAt: new Date("2026-09-26T13:00:00.000Z") });
    /** Banco que respeita o cursor do pump (id > cursor lido do SQL) e os recibos já gravados. */
    function cursorAwareDb(events: Array<ReturnType<typeof cancelledEvent>>) {
      const queries: number[] = [];
      mockedGetDb.mockResolvedValue({ select: vi.fn(() => ({ from: (table: unknown) => {
        let condition: unknown;
        const q: Record<string, unknown> = {};
        for (const method of ["innerJoin", "leftJoin", "orderBy", "limit"]) q[method] = () => q;
        q.where = (cond: unknown) => { condition = cond; return q; };
        q.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
          const cursorParam = condition ? dialect.sqlToQuery(condition as never).params.find(param => typeof param === "number") : undefined;
          let rows: unknown[] = [];
          if (table === domainEvents && typeof cursorParam === "number") { queries.push(cursorParam); rows = events.filter(event => event.id > cursorParam); }
          else if (table === domainEvents) rows = [lineageEvent];
          else if (table === contracts) rows = [lineageRow];
          else if (table === auditLogs) rows = [];
          return Promise.resolve(rows).then(resolve, reject);
        };
        return q;
      } })) } as never);
      return queries;
    }
    const respond = (status: number, body: string = "{}") => new Response(body, { status, headers: { "Content-Type": "application/json" } });
    const sales = (onError = vi.fn()) => ({ onError, pump: eagerPump(startSalesCancellationBridgePump, "http://127.0.0.1:3100", "k", { autoStart: false, onError, rejectionWindowMs: 600_000 }) });

    it.each([
      [422, "INVALID_CRM_EVENT"], [404, "SALE_NOT_FOUND"], [409, "SALE_NOT_CONFIRMED"], [409, "CRM_EVENT_IDENTITY_CONFLICT"], [400, "INVALID_CRM_EVENT"],
    ])("Sales: HTTP %i + code %s => recibo terminal na 1ª vez, com o código, e a fila segue", async (status, code) => {
      cursorAwareDb([cancelledEvent(90, 303), cancelledEvent(91, 304)]);
      mockedRecordAudit.mockResolvedValue(undefined);
      mockedFetch.mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).contractId === "303" ? respond(status, JSON.stringify({ code })) : respond(201));
      const { onError, pump } = sales();
      try {
        expect(await pump.tick()).toBe(1); // o seguinte (304) foi entregue no mesmo tick
        expect(mockedRecordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_cancellation_rejected",
          `crm.contract.cancelled.v1 recusado pelo TGR Sales Command (HTTP ${status}, code ${code}).`, { idempotencyKey: "sales-contract:303:cancelled" });
        expect(onError).toHaveBeenCalledTimes(1);
        const attemptsBefore = mockedFetch.mock.calls.length;
        await pump.tick(); await pump.tick();
        // cursor avançou além do recusado: ele não volta a travar nem a ser reenviado
        expect(mockedFetch.mock.calls.length).toBe(attemptsBefore);
      } finally { pump.stop(); }
    });

    it.each([408, 425, 429, 500, 502, 503])("Sales: HTTP %i mesmo com code NUNCA é terminal (transitório): tenta de novo", async status => {
      cursorAwareDb([cancelledEvent(90, 303)]);
      mockedFetch.mockImplementation(async () => respond(status, JSON.stringify({ code: "SOME_CODE" })));
      const { onError, pump } = sales();
      try { for (let i = 0; i < 7; i += 1) expect(await pump.tick()).toBe(0); } finally { pump.stop(); }
      expect(mockedRecordAudit).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(7);
    });

    it.each([
      ["sem corpo JSON", "not json"], ["sem code", "{}"], ["code minúsculo", JSON.stringify({ code: "invalid_event" })], ["code com espaço", JSON.stringify({ code: "BAD CODE" })], ["code não-string", JSON.stringify({ code: 422 })], ["code vazio", JSON.stringify({ code: "" })],
    ])("Sales: 422 %s é recusa SEM código: regra antiga (repetida), não terminal na 1ª", async (_label, body) => {
      cursorAwareDb([cancelledEvent(90, 303)]);
      mockedFetch.mockImplementation(async () => respond(422, body));
      const pump = eagerPump(startSalesCancellationBridgePump, "http://127.0.0.1:3100", "k", { autoStart: false, onError: vi.fn(), rejectionWindowMs: 0 });
      try {
        for (let i = 0; i < 4; i += 1) await pump.tick();
        expect(mockedRecordAudit).not.toHaveBeenCalled();
        await pump.tick();
      } finally { pump.stop(); }
      expect(mockedRecordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_cancellation_rejected", "crm.contract.cancelled.v1 recusado pelo TGR Sales Command 5x seguidas (HTTP 422).", { idempotencyKey: "sales-contract:303:cancelled" });
    });

    it("Sales: 401/403/404 sem code continuam tentando (chave/endpoint errados)", async () => {
      for (const status of [401, 403, 404]) {
        vi.resetAllMocks();
        cursorAwareDb([cancelledEvent(90, 303)]);
        mockedFetch.mockImplementation(async () => respond(status));
        const { pump } = sales();
        try { for (let i = 0; i < 7; i += 1) await pump.tick(); } finally { pump.stop(); }
        expect(mockedRecordAudit).not.toHaveBeenCalled();
      }
    });

    it("Relationship: comportamento inalterado (422 com code NÃO é terminal na 1ª; 5 repetições + janela sim)", async () => {
      const activeEvent = { ...cancelledEvent(90, 303), payload: JSON.stringify({ status: "active" }) };
      cursorAwareDb([activeEvent]);
      mockedFetch.mockImplementation(async () => respond(422, JSON.stringify({ code: "INVALID_CRM_EVENT" })));
      const pump = eagerPump(startRelationshipBridgePump, "http://127.0.0.1:3200", "k", { autoStart: false, onError: vi.fn(), rejectionWindowMs: 0 });
      try {
        for (let i = 0; i < 4; i += 1) await pump.tick();
        expect(mockedRecordAudit).not.toHaveBeenCalled();
        await pump.tick();
      } finally { pump.stop(); }
      expect(mockedRecordAudit).toHaveBeenCalledWith(null, "contract", 303, "relationship_rejected", "crm.contract.activated.v1 recusado pelo TGR Relationship 5x seguidas (HTTP 422).", { idempotencyKey: "relationship-contract:303:active" });
    });

    it("tracker: coded=true é terminal na 1ª; coded=false (padrão) ignora o code", () => {
      const rejected = new DeliveryRejectedError("Sales Command", 422, "INVALID_CRM_EVENT");
      expect(createRejectionTracker<string>(600_000, undefined, { codedRejections: true }).record("k", rejected)).toBe(true);
      expect(createRejectionTracker<string>(600_000).record("k", rejected)).toBe(false);
      expect(createRejectionTracker<string>(600_000, undefined, { codedRejections: true }).record("k", new DeliveryRejectedError("Sales Command", 503, "X"))).toBe(false);
    });
  });

  describe("buildContractStateBody é exaustivo (revisão KAN-31)", () => {
    const lineage = { saleId: "s", projectExternalKey: "p", projectName: "n", projectTimezone: "tz", correlationId: null, customerId: 1, customerName: "c", customerPhone: null, cancellationReason: null };
    const at = new Date("2026-10-06T12:00:00Z");
    it("active/cancelled geram o evento certo", () => {
      expect(buildContractStateBody(lineage, "active", 9, at, false).eventName).toBe("crm.contract.activated.v1");
      expect(buildContractStateBody(lineage, "cancelled", 9, at, false).eventName).toBe("crm.contract.cancelled.v1");
    });
    it("validated NUNCA sai como cancelado: lança (tem builder próprio) e status desconhecido também", () => {
      expect(() => buildContractStateBody(lineage, "validated", 9, at, false)).toThrow(/validated/);
      expect(() => buildContractStateBody(lineage, "closed" as never, 9, at, false)).toThrow(/closed/);
      expect(() => buildContractStateBody(lineage, undefined as never, 9, at, false)).toThrow();
    });
  });
});
