import { describe, expect, it } from "vitest";
import { domainEventCatalog, domainEventDefinition, isKnownDomainEvent } from "../shared/domainEvents";

describe("catálogo de eventos de domínio", () => {
  it("reconhece somente eventos registrados e preserva o agregado esperado", () => {
    expect(isKnownDomainEvent("contract.status.updated")).toBe(true);
    expect(isKnownDomainEvent("contract.alguem_inventou_isso")).toBe(false);
    expect(domainEventDefinition("customer.document.uploaded")).toMatchObject({ aggregateType: "customer_document" });
  });

  it("mantém cobertura de CRM, contratos, comercial, operação e financeiro", () => {
    const names = Object.keys(domainEventCatalog);
    expect(names.some(name => name.startsWith("customer."))).toBe(true);
    expect(names.some(name => name.startsWith("contract."))).toBe(true);
    expect(names.some(name => name.startsWith("opportunity.") || name.startsWith("proposal."))).toBe(true);
    expect(names.some(name => name.startsWith("ownership.") || name.startsWith("unit."))).toBe(true);
    expect(names.some(name => name.startsWith("installment.") || name.startsWith("financial."))).toBe(true);
  });
});

describe("ADR-010: eventos internos de comissão (não retransmitidos)", () => {
  const internal = ["commission.automatic.skipped", "commission.reversal_review.requested", "commission.reversal_review.resolved"] as const;
  it("estão no catálogo com o agregado esperado", () => {
    for (const name of internal) expect(isKnownDomainEvent(name)).toBe(true);
    expect(domainEventDefinition("commission.automatic.skipped")).toMatchObject({ aggregateType: "installment" });
    expect(domainEventDefinition("commission.reversal_review.resolved")).toMatchObject({ aggregateType: "sales_commission" });
  });
  it("NÃO fazem parte da lista que a ponte financeira retransmite", async () => {
    const { FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    for (const name of internal) expect((FINANCIAL_EVENT_NAMES as readonly string[]).includes(name)).toBe(false);
  });
  it("o feed de integração só expõe campos permitidos (notas e texto livre ficam de fora)", async () => {
    const { toIntegrationEvent } = await import("../shared/integrationContract");
    const event = toIntegrationEvent({ id: 1, eventName: "commission.reversal_review.resolved", aggregateType: "sales_commission", aggregateId: "7", actorUserId: 5, occurredAt: new Date("2026-10-07T12:00:00Z"), payload: JSON.stringify({ contractId: 9, commissionId: 7, decision: "offset", financialTransactionId: 3, note: "privado" }) });
    expect(event.payload).toEqual({ contractId: 9, commissionId: 7, decision: "offset", financialTransactionId: 3 });
  });
});
