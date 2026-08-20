import { expect, test } from "@playwright/test";

const admin = { id: 1, openId: "test", name: "Lucas", email: "lucas@example.com", loginMethod: "test", role: "admin", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", lastSignedIn: "2026-08-01T00:00:00.000Z" };
const query = (json: unknown) => ({ result: { data: { json } } });

test.describe("exportações e reversão autenticadas", () => {
  test("baixa XLSX e PDF filtrados da etapa do funil", async ({ page }) => {
    await page.route("**/api/trpc/dashboard.summary,dashboard.commercialCharts,dashboard.operationalPulse,auth.me**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([
      query({ activeContracts: 0, overdueAmount: 0, occupancy: 0, salesThisMonth: 0, pendingTasks: 0, openEntries: 0 }),
      query({ funnel: [{ stage: "new", count: 0, amount: 0 }, { stage: "qualified", count: 0, amount: 0 }, { stage: "proposal", count: 1, amount: 12500 }, { stage: "negotiation", count: 0, amount: 0 }, { stage: "won", count: 0, amount: 0 }, { stage: "lost", count: 0, amount: 0 }], goals: [], sellers: [], range: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-31T00:00:00.000Z" } }),
      query({ exceptions: [], adoption: { eventsLast30Days: 0, activeOperators: 0, interactionsLast30Days: 0 } }), query(admin),
    ]) }));
    await page.route("**/api/trpc/dashboard.funnelDetails?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([query([{ opportunity: { id: 9, title: "Cota Família", expectedAmount: 12500, probability: 70, createdAt: "2026-08-10T12:00:00.000Z" }, customerName: "Ana", sellerName: "Vendedor" }])]) }));
    await page.goto("/");
    await page.locator(".recharts-bar-rectangle").nth(2).click();
    await expect(page.getByRole("button", { name: "Excel" })).toBeVisible();
    const xlsxDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "Excel" }).click();
    expect((await xlsxDownload).suggestedFilename()).toMatch(/tse-propostas-proposal-.*\.xlsx/);
    const pdfDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "PDF" }).click();
    expect((await pdfDownload).suggestedFilename()).toMatch(/tse-propostas-proposal-.*\.pdf/);
  });

  test("confirma e executa reversão do último lote CSV na interface", async ({ page }) => {
    await page.route("**/api/trpc/auth.me,imports.latestBatch**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([query(admin), query({ id: 44, kind: "customers", createdCount: 2, updatedCount: 1, canUndo: true })]) }));
    await page.route("**/api/trpc/imports.undoLast?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([query({ batchId: 44, revertedItems: 3 })]) }));
    page.on("dialog", dialog => dialog.accept());
    await page.goto("/importar");
    await page.getByRole("button", { name: "Desfazer último lote" }).click();
    await expect(page.getByText("Lote 44 revertido com 3 item(ns).")).toBeVisible();
  });
});
