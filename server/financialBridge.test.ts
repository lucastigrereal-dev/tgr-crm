import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: vi.fn() }));

import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";
import { FINANCIAL_EVENT_NAMES, financialBridgeEnvelope, financialBridgeTarget, startFinancialBridgePump } from "./financialBridge";

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
      const pump = startFinancialBridgePump("http://127.0.0.1:3400", "k", project, { autoStart: false, onError, rejectionWindowMs: 0 });
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
        const pump = startFinancialBridgePump("http://127.0.0.1:3400", "k", project, { autoStart: false, onError: vi.fn() });
        try { for (let n = 0; n < 8; n += 1) expect(await pump.tick()).toBe(0); } finally { pump.stop(); }
        expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
      }
    });
  });
});
