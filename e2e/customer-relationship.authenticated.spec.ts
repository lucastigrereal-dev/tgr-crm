import { expect, test } from "@playwright/test";

test.describe("ficha de relacionamento autenticada", () => {
  test("renderiza central, radar e onboarding com o contrato consolidado", async ({ page }) => {
    await page.route("**/api/trpc/customers.detail**", async route => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify([{
        result: { data: { json: {
          customer: { id: 9, fullName: "Ana Exemplo", email: "ana@example.com", phone: "11999999999", status: "active", documentNumber: null, acquisitionSource: "Tour", address: null, addressNumber: null, neighborhood: null, city: "Olímpia", state: "SP", notes: null },
          interactions: [{ id: 2, type: "whatsapp", direction: "outgoing", subject: "Boas-vindas", content: "Contato de onboarding confirmado.", occurredAt: "2026-08-16T12:00:00.000Z" }],
          documents: [{ id: 3, filename: "rg.pdf", type: "Documento pessoal", storageKey: "customers/9/rg.pdf", createdAt: "2026-08-12T12:00:00.000Z" }],
          contracts: [{ id: 4, number: "CTR-009", status: "active", totalAmount: "5000.00", usageModel: "fixed_week" }],
          opportunities: [], reservations: [{ id: 5, checkIn: "2026-09-10T12:00:00.000Z", checkOut: "2026-09-17T12:00:00.000Z", status: "confirmed" }],
          relationshipTasks: [{ id: 7, title: "Ligar para confirmar reserva", status: "open", dueAt: "2026-08-21T12:00:00.000Z" }],
          radar: { score: 100, label: "saudável", signals: ["Relacionamento com cadência, dados e situação financeira sob controle."], onboarding: [{ label: "Canais de contato completos", complete: true }, { label: "Primeiro contato registrado", complete: true }, { label: "Contrato ativo", complete: true }, { label: "Documento anexado", complete: true }, { label: "Primeira experiência de uso agendada", complete: true }] },
        } } },
      }]) });
    });

    await page.goto("/clientes/9");
    await expect(page.getByRole("heading", { name: "Ana Exemplo" })).toBeVisible();
    await expect(page.getByText("Central de relacionamento", { exact: true })).toBeVisible();
    await expect(page.getByText("Ligar para confirmar reserva")).toBeVisible();
    await expect(page.getByText("Radar de relacionamento", { exact: true })).toBeVisible();
    await expect(page.getByText(/Canais de contato completos/i)).toBeVisible();
  });
});
