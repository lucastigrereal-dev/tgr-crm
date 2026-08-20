import { expect, test } from "@playwright/test";

const trpc = (json: unknown) => JSON.stringify([{ result: { data: { json } } }]);
const customerDetail = {
  customer: { id: 9, fullName: "Ana Exemplo", email: "ana@example.com", phone: "11999999999", status: "active", documentNumber: null, acquisitionSource: "Tour", address: null, addressNumber: null, neighborhood: null, city: "Olímpia", state: "SP", notes: null },
  interactions: [], documents: [], contracts: [], opportunities: [], reservations: [], relationshipTasks: [],
  radar: { score: 70, label: "atenção", signals: ["Cadência pendente."], onboarding: [] },
};
const assistantResult = {
  answer: "O próximo passo é confirmar a disponibilidade do associado.", confidence: "medium",
  evidence: [{ id: "E1", kind: "associado", title: "Ana Exemplo", detail: "Status cadastral: active." }],
  recommendedActions: [{ title: "Ligar para Ana", rationale: "Há necessidade de confirmação.", requiresHumanApproval: true }],
  limitations: ["Não há interação recente."], model: "gpt-5-mini",
};

test.describe("copiloto do associado autenticado", () => {
  test("exibe resposta fundamentada sem executar a recomendação", async ({ page }) => {
    await page.route("**/api/trpc/customers.detail**", route => route.fulfill({ contentType: "application/json", body: trpc(customerDetail) }));
    await page.route("**/api/trpc/ai.analyzeCustomer?**", route => route.fulfill({ contentType: "application/json", body: trpc(assistantResult) }));
    await page.goto("/clientes/9");
    await page.getByRole("button", { name: "Consultar IA" }).click();
    await page.getByLabel("Pergunta sobre este associado").fill("Qual o próximo passo?");
    await page.getByRole("button", { name: "Analisar com evidências" }).click();
    await expect(page.getByText(assistantResult.answer)).toBeVisible();
    await expect(page.getByText("E1 · associado · Ana Exemplo")).toBeVisible();
    await expect(page.getByText("Aprovação humana obrigatória")).toBeVisible();
    await expect(page.getByText("Ligar para Ana")).toBeVisible();
  });
});
