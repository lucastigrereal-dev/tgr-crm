import { expect, test } from "@playwright/test";

test.describe("dashboard de exceções autenticado", () => {
  test("exibe exceção operacional e abre o drill-down de contexto", async ({ page }) => {
    await page.route("**/api/trpc/dashboard.summary,dashboard.commercialCharts,dashboard.operationalPulse,auth.me**", async route => {
      const body = [
        { result: { data: { json: { activeContracts: 1, overdueAmount: 420, occupancy: 25, salesThisMonth: 0, pendingTasks: 1, openEntries: 0 } } } },
        { result: { data: { json: { funnel: [{ stage: "new", count: 0, amount: 0 }, { stage: "qualified", count: 0, amount: 0 }, { stage: "proposal", count: 0, amount: 0 }, { stage: "negotiation", count: 0, amount: 0 }, { stage: "won", count: 0, amount: 0 }, { stage: "lost", count: 0, amount: 0 }], goals: [], sellers: [], range: { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" } } } } },
        { result: { data: { json: { exceptions: [{ id: "installment-8", severity: "critical", module: "finance", title: "Parcela em atraso · Ana · CTR-8", description: "31 dia(s) de atraso · R$ 420,00" }], adoption: { eventsLast30Days: 12, activeOperators: 3, interactionsLast30Days: 7 } } } } },
        { result: { data: { json: { id: 1, openId: "test", name: "Lucas", email: "lucas@example.com", loginMethod: "test", role: "admin", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", lastSignedIn: "2026-08-01T00:00:00.000Z" } } } },
      ];
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/");
    await expect(page.getByText("Parcela em atraso · Ana · CTR-8")).toBeVisible();
    await page.getByText("Parcela em atraso · Ana · CTR-8").click();
    await expect(page.getByRole("dialog")).toContainText("31 dia(s) de atraso · R$ 420,00");
    await expect(page.getByText("3").last()).toBeVisible();
  });
});
