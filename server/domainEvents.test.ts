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
