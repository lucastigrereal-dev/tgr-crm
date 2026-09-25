import { describe, expect, it } from "vitest";
import { financialBridgeEnvelope, financialBridgeTarget } from "./financialBridge";

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
        gatewayPaymentId: "pay_1",
        privateCardData: "must-not-leak",
      }),
    }, {
      externalKey: "22222222-2222-4222-8222-222222222222",
      name: "Ponta Negra Eco Resort",
      timezone: "America/Recife",
    });

    expect(body).toMatchObject({
      source: "crm",
      correlationId: "crm-fin-77",
      project: {
        externalKey: "22222222-2222-4222-8222-222222222222",
        name: "Ponta Negra Eco Resort",
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
          gatewayPaymentId: "pay_1",
        },
      },
    });
    expect(body.event.payload).not.toHaveProperty("privateCardData");
  });
});
