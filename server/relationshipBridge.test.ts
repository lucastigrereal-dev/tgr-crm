import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: vi.fn() }));

import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";
import { createRejectionTracker, DeliveryRejectedError, startRelationshipBridgePump, startSalesCancellationBridgePump } from "./relationshipBridge";

const mockedGetDb = vi.mocked(getDb);
const mockedRecordAudit = vi.mocked(recordAudit);
const mockedFetch = vi.mocked(fetchWithTimeout);

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
  for (const method of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) promise[method] = () => promise;
  return promise;
}

describe("CRM to Relationship bridge", () => {
  afterEach(() => vi.resetAllMocks());

  it("requires TLS outside loopback", () => {
    expect(() => startRelationshipBridgePump("http://relationship.internal:3200", "relationship-key", { autoStart: false }))
      .toThrow("Relationship endpoint requires TLS outside loopback");
    expect(() => startRelationshipBridgePump("https://relationship.example.invalid", "relationship-key", { autoStart: false }))
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

    const pump = startRelationshipBridgePump("http://127.0.0.1:3200", "relationship-key", { autoStart: false });
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

    const pump = startSalesCancellationBridgePump("http://127.0.0.1:3100", "sales-cancel-key", { autoStart: false });
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
    expect(() => startSalesCancellationBridgePump("http://sales.internal:3100", "k", { autoStart: false }))
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
    let selectIndex = 0; // cada tick refaz as mesmas 4 leituras (o cursor não avança enquanto falha)
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => chain(sequence[selectIndex++ % sequence.length])) } as never);
  }

  it("writes a terminal receipt only after repeated content rejections (409), so one poison event cannot pin the queue", async () => {
    cancellationDb();
    mockedFetch.mockImplementation(async () => new Response("{}", { status: 409 }));
    mockedRecordAudit.mockResolvedValue(undefined);
    const onError = vi.fn();
    const pump = startSalesCancellationBridgePump("http://127.0.0.1:3100", "k", { autoStart: false, onError, rejectionWindowMs: 0 });
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
      const pump = startSalesCancellationBridgePump("http://127.0.0.1:3100", "k", { autoStart: false, onError, rejectionWindowMs: 0 });
      try { for (let i = 0; i < 8; i += 1) expect(await pump.tick()).toBe(0); } finally { pump.stop(); }
      expect(mockedRecordAudit).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(8);
    }
  });

  it("never rejects the tick when the database fails outside delivery", async () => {
    mockedGetDb.mockRejectedValue(new Error("db down"));
    const onError = vi.fn();
    const pump = startRelationshipBridgePump("http://127.0.0.1:3200", "k", { autoStart: false, onError });
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
});
