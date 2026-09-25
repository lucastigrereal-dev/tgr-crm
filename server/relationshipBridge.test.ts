import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: vi.fn() }));

import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";
import { startRelationshipBridgePump } from "./relationshipBridge";

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
          projectName: "Ponta Negra Eco Resort",
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
        name: "Ponta Negra Eco Resort",
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
});
