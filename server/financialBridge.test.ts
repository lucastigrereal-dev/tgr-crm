import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: vi.fn() }));

import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";
import { FINANCIAL_EVENT_NAMES, financialBridgeEnvelope, financialBridgeTarget, startFinancialBridgePump } from "./financialBridge";

// Backoff por evento (RED TEAM P2): cada tick de teste avança o relógio além do teto (10 min), então todo evento em retry está vencido.
const pumpClock = { t: 0 };
function eagerPump<P extends { tick(): Promise<number>; stop(): void }>(start: (...args: any[]) => P, ...args: any[]): P {
  const last = args.length - 1;
  const pump = start(...args.slice(0, last), { ...args[last], now: () => pumpClock.t });
  return { ...pump, tick: async () => { pumpClock.t += 11 * 60_000; return pump.tick(); } };
}

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
  for (const method of ["from", "where", "orderBy", "limit", "leftJoin"]) promise[method] = () => promise;
  return promise;
}

describe("CRM -> Financial bridge", () => {
  it("requires TLS outside loopback", () => {
    expect(() => financialBridgeTarget("http://financial.internal:3400")).toThrow("requires TLS");
    expect(financialBridgeTarget("http://127.0.0.1:3400")).toBe("http://127.0.0.1:3400/api/integration/crm-events");
  });

  it("wraps the allowlisted CRM event with canonical project identity", () => {
    const body = financialBridgeEnvelope({
      id: 77,
      eventName: "installment.paid",
      aggregateType: "installment",
      aggregateId: "9001",
      actorUserId: 3,
      occurredAt: new Date("2026-09-25T12:00:00.000Z"),
      payload: JSON.stringify({
        installmentId: 9001,
        paidAmount: "3600.00",
        contractId: 303,
        customerId: 44,
        gatewayPaymentId: "pay_1",
        privateCardData: "must-not-leak",
      }),
    }, {
      externalKey: "22222222-2222-4222-8222-222222222222",
      name: "SYN Resort Laboratório",
      timezone: "America/Recife",
    });

    expect(body).toMatchObject({
      source: "crm",
      correlationId: "crm-fin-77",
      project: {
        externalKey: "22222222-2222-4222-8222-222222222222",
        name: "SYN Resort Laboratório",
      },
      event: {
        contractVersion: "tgr.events.v1",
        eventId: 77,
        eventName: "installment.paid",
        aggregate: { type: "installment", id: "9001" },
        payload: {
          installmentId: 9001,
          paidAmount: "3600.00",
          contractId: 303,
          customerId: 44,
          gatewayPaymentId: "pay_1",
        },
      },
    });
    expect(body.event.payload).not.toHaveProperty("privateCardData");
  });
  it("forwards contract.created.v2 with total, sale and currency", () => {
    const body = financialBridgeEnvelope({ id: 90, eventName: "contract.created.v2", aggregateType: "contract", aggregateId: "61", actorUserId: null,
      occurredAt: new Date("2026-10-04T12:00:00.000Z"), payload: JSON.stringify({ contractId: 61, saleId: "S-1", customerId: 10, totalAmount: "19750.00", currency: "BRL", status: "pending_signature", usageModel: "fixed_week", source: "sales-command" }) },
      { externalKey: "22222222-2222-4222-8222-222222222222", name: "SYN", timezone: "America/Recife" });
    expect(body.event).toMatchObject({ eventName: "contract.created.v2", payload: { contractId: 61, saleId: "S-1", totalAmount: "19750.00", currency: "BRL" } });
    expect(FINANCIAL_EVENT_NAMES).toContain("contract.created.v2");
  });

  describe("pump failure handling", () => {
    afterEach(() => vi.resetAllMocks());
    const project = { externalKey: "22222222-2222-4222-8222-222222222222", name: "SYN", timezone: "America/Recife" };
    function oneEvent() {
      const event = { id: 501, eventName: "contract.status.updated", aggregateType: "contract", aggregateId: "303", actorUserId: null,
        payload: JSON.stringify({ status: "active" }), idempotencyKey: null, occurredAt: new Date("2026-10-04T12:00:00.000Z") };
      const sequence: unknown[] = [[{ event }], []];
      let i = 0;
      vi.mocked(getDb).mockResolvedValue({ select: vi.fn(() => chain(sequence[i++ % sequence.length])) } as never);
    }

    it("stores a rejection receipt only after 5 consecutive content rejections (400)", async () => {
      oneEvent();
      vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response("{}", { status: 400 }));
      const onError = vi.fn();
      const pump = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError, rejectionWindowMs: 0 });
      try {
        for (let n = 1; n < 5; n += 1) await pump.tick();
        expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
        await pump.tick();
      } finally { pump.stop(); }
      expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(null, "integration_event", 501, "financial_rejected",
        "contract.status.updated recusado pelo TGR Financial Layer 5x seguidas (HTTP 400).", { idempotencyKey: "financial-event:501" });
      expect(onError).toHaveBeenCalledTimes(5);
    });

    it("never stores a receipt for wrong key, missing route or transient failures", async () => {
      for (const status of [401, 404, 502]) {
        vi.resetAllMocks();
        oneEvent();
        vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response("{}", { status }));
        const pump = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError: vi.fn() });
        try { for (let n = 0; n < 8; n += 1) expect(await pump.tick()).toBe(0); } finally { pump.stop(); }
        expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
      }
    });

    // ---- revisão KAN-31 (PIL-008)
    function twoEvents() {
      const mk = (id: number, aggregateId: string) => ({ id, eventName: "contract.status.updated", aggregateType: "contract", aggregateId, actorUserId: null, payload: JSON.stringify({ status: "active", contractId: Number(aggregateId), customerId: 5 }), idempotencyKey: null, occurredAt: new Date("2026-10-04T12:00:00.000Z") });
      const events = [mk(501, "303"), mk(502, "304")];
      const pending = () => events.filter(event => !vi.mocked(recordAudit).mock.calls.some(call => (call[5] as { idempotencyKey?: string } | undefined)?.idempotencyKey === "financial-event:" + event.id)).map(event => ({ event }));
      // A consulta de eventos é a única com leftJoin; as demais (recibo já tratado, cliente do contrato) voltam vazias.
      vi.mocked(getDb).mockResolvedValue({ select: vi.fn(() => { let rows: unknown[] = []; const q: Record<string, unknown> = {}; for (const method of ["from", "where", "orderBy", "limit"]) q[method] = () => q; q.leftJoin = () => { rows = pending(); return q; }; q.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject); return q; }) } as never);
    }
    const respond = (status: number, body = "{}") => new Response(body, { status, headers: { "Content-Type": "application/json" } });

    it.each([
      [422, "COMMISSION_REQUIRES_VALIDATED_SALE"], [400, "INVALID_CRM_EVENT"], [409, "INVALID_CRM_EVENT"],
    ])("HTTP %i + code %s => recibo terminal na 1ª vez, com o código, sem travar o evento seguinte", async (status, code) => {
      twoEvents();
      vi.mocked(recordAudit).mockResolvedValue(undefined);
      vi.mocked(fetchWithTimeout).mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).event.eventId === 501 ? respond(status, JSON.stringify({ code })) : respond(201));
      const onError = vi.fn();
      const pump = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError, rejectionWindowMs: 600_000 });
      try {
        expect(await pump.tick()).toBe(1);
        expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(null, "integration_event", 501, "financial_rejected",
          `contract.status.updated recusado pelo TGR Financial Layer (HTTP ${status}, code ${code}).`, { idempotencyKey: "financial-event:501" });
        expect(onError).toHaveBeenCalledTimes(1);
        const attempts = vi.mocked(fetchWithTimeout).mock.calls.length;
        await pump.tick();
        expect(vi.mocked(fetchWithTimeout).mock.calls.length).toBe(attempts); // nada mais a reenviar: recusado e entregue têm recibo
      } finally { pump.stop(); }
    });

    it.each([408, 425, 429, 500, 503])("HTTP %i com code continua transitório: nunca vira recibo", async status => {
      oneEvent();
      vi.mocked(fetchWithTimeout).mockImplementation(async () => respond(status, JSON.stringify({ code: "COMMISSION_REQUIRES_VALIDATED_SALE" })));
      const pump = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError: vi.fn(), rejectionWindowMs: 0 });
      try { for (let n = 0; n < 7; n += 1) expect(await pump.tick()).toBe(0); } finally { pump.stop(); }
      expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
    });

    it.each([["sem code", "{}"], ["code minúsculo", JSON.stringify({ code: "bad_code" })], ["corpo não JSON", "oops"]])("422 %s segue a regra antiga: só após 5 repetições", async (_label, body) => {
      oneEvent();
      vi.mocked(fetchWithTimeout).mockImplementation(async () => respond(422, body));
      const pump = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError: vi.fn(), rejectionWindowMs: 0 });
      try {
        for (let n = 1; n < 5; n += 1) await pump.tick();
        expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
        await pump.tick();
      } finally { pump.stop(); }
      expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(null, "integration_event", 501, "financial_rejected", "contract.status.updated recusado pelo TGR Financial Layer 5x seguidas (HTTP 422).", { idempotencyKey: "financial-event:501" });
    });
  });
});
