import { describe, expect, it } from "vitest";
import { toIntegrationEvent } from "../shared/integrationContract";

describe("contrato de integração v1", () => {
  it("filtra payload ao allowlist do evento e mantém envelope versionado", () => {
    const event = toIntegrationEvent({ id: 2, eventName: "customer.updated", aggregateType: "customer", aggregateId: "9", actorUserId: 3, occurredAt: new Date("2026-08-20T12:00:00Z"), payload: JSON.stringify({ status: "active", city: "Olímpia", email: "privado@example.com", notes: "segredo" }) });
    expect(event).toMatchObject({ contractVersion: "tgr.events.v1", eventId: 2, aggregate: { type: "customer", id: "9" }, payload: { status: "active", city: "Olímpia" } });
    expect(event.payload).not.toHaveProperty("email");
  });

  it("preserva contexto comercial permitido em oportunidades", () => {
    const created = toIntegrationEvent({ id: 6, eventName: "opportunity.created", aggregateType: "opportunity", aggregateId: "301", actorUserId: 7, occurredAt: new Date("2026-08-20T12:00:00Z"), payload: JSON.stringify({ customerId: 10, sellerId: 71, stage: "qualified", expectedAmount: 12000, campaignId: 9, notes: "privado" }) });
    const updated = toIntegrationEvent({ id: 7, eventName: "opportunity.updated", aggregateType: "opportunity", aggregateId: "301", actorUserId: 7, occurredAt: new Date("2026-08-20T12:00:00Z"), payload: JSON.stringify({ sellerId: 72, previousStage: "qualified", stage: "won", expectedAmount: 15000, campaignId: 9, notes: "privado" }) });

    expect(created.payload).toEqual({ customerId: 10, sellerId: 71, stage: "qualified", expectedAmount: 12000, campaignId: 9 });
    expect(updated.payload).toEqual({ sellerId: 72, previousStage: "qualified", stage: "won", expectedAmount: 15000, campaignId: 9 });
    expect(created.payload).not.toHaveProperty("notes");
    expect(updated.payload).not.toHaveProperty("notes");
  });

  it("preserva a origem da comissão automática bloqueada", () => {
    const blocked = toIntegrationEvent({ id: 5, eventName: "commission.automatic.blocked", aggregateType: "installment", aggregateId: "91", actorUserId: 7, occurredAt: new Date("2026-08-20T12:00:00Z"), payload: JSON.stringify({ contractId: 61, reason: "incomplete_project_policy", source: "manual", notes: "privado" }) });

    expect(blocked.payload).toEqual({ contractId: 61, reason: "incomplete_project_policy", source: "manual" });
    expect(blocked.payload).not.toHaveProperty("notes");
  });

  it("preserva contexto financeiro permitido em lançamentos e repasses", () => {
    const entry = toIntegrationEvent({ id: 3, eventName: "financial.entry.created", aggregateType: "financial_transaction", aggregateId: "41", actorUserId: 7, occurredAt: new Date("2026-08-20T12:00:00Z"), payload: JSON.stringify({ type: "income", category: "Taxa", amount: 125, contractId: 61, campaignId: 9, description: "privado" }) });
    const transfer = toIntegrationEvent({ id: 4, eventName: "financial.transfer.created", aggregateType: "financial_transfer", aggregateId: "42", actorUserId: 7, occurredAt: new Date("2026-08-20T12:00:00Z"), payload: JSON.stringify({ recipient: "Parceiro", amount: 250, contractId: 61, description: "privado" }) });

    expect(entry.payload).toEqual({ type: "income", category: "Taxa", amount: 125, contractId: 61, campaignId: 9 });
    expect(transfer.payload).toEqual({ amount: 250, recipient: "Parceiro", contractId: 61 });
  });
});
