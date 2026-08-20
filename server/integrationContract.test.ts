import { describe, expect, it } from "vitest";
import { toIntegrationEvent } from "../shared/integrationContract";

describe("contrato de integração v1", () => {
  it("filtra payload ao allowlist do evento e mantém envelope versionado", () => {
    const event = toIntegrationEvent({ id: 2, eventName: "customer.updated", aggregateType: "customer", aggregateId: "9", actorUserId: 3, occurredAt: new Date("2026-08-20T12:00:00Z"), payload: JSON.stringify({ status: "active", city: "Olímpia", email: "privado@example.com", notes: "segredo" }) });
    expect(event).toMatchObject({ contractVersion: "tse.events.v1", eventId: 2, aggregate: { type: "customer", id: "9" }, payload: { status: "active", city: "Olímpia" } });
    expect(event.payload).not.toHaveProperty("email");
  });
});
