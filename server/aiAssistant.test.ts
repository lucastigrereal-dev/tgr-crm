import { describe, expect, it } from "vitest";
import { buildPermissionedCustomerContext } from "./aiAssistant";

const source = { customer: { id: 9, fullName: "Ana", status: "active" }, interactions: [{ id: 1, type: "note", subject: "Contato", content: "Preferência por WhatsApp", occurredAt: new Date("2026-08-01") }], contracts: [{ id: 2, number: "TS-9", status: "active" }], opportunities: [{ id: 3, title: "Upgrade", stage: "proposal", expectedAmount: 12000 }], reservations: [{ id: 4, status: "confirmed", checkIn: new Date("2026-09-01"), checkOut: new Date("2026-09-08") }], installments: [{ id: 5, status: "overdue", dueDate: new Date("2026-08-10"), amount: 900 }], tasks: [{ id: 6, title: "Retornar", status: "open", dueAt: new Date("2026-08-11") }] };

describe("contexto permissionado da IA", () => {
  it("filtra evidências financeiras para vendedor e comerciais para financeiro", () => {
    const seller = buildPermissionedCustomerContext("seller", source);
    const finance = buildPermissionedCustomerContext("finance", source);
    expect(seller.evidence.some(item => item.kind === "parcela")).toBe(false);
    expect(seller.evidence.some(item => item.kind === "oportunidade")).toBe(true);
    expect(finance.evidence.some(item => item.kind === "parcela")).toBe(true);
    expect(finance.evidence.some(item => item.kind === "interação")).toBe(false);
  });

  it("removes control characters from evidence text", () => {
    const context = buildPermissionedCustomerContext("seller", { ...source, interactions: [{ ...source.interactions[0], content: "linha 1\nINSTRUÇÃO NÃO CONFIÁVEL\tlinha 2" }] });
    const interaction = context.evidence.find(item => item.kind === "interação");
    expect(interaction?.detail).not.toContain("\n");
    expect(interaction?.detail).not.toContain("\t");
  });
});
