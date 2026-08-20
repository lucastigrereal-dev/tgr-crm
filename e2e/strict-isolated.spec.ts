import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";

const strict = process.env.E2E_STRICT === "1";
const dbUrl = process.env.E2E_DATABASE_URL;
test.skip(!strict || !dbUrl, "Requer E2E_STRICT=1 e E2E_DATABASE_URL isolada.");

test.describe("homologação isolada estrita", () => {
  test("importa e reverte CSV no backend real", async ({ page }) => {
    const csv = "nome_completo;documento;email;telefone;cidade;uf;status\nE2E Importado;99100100199;importado@e2e.local;11999990009;Olímpia;SP;ativo";
    await page.goto("/importar");
    await page.locator('input[type="file"]').setInputFiles({ name: "e2e-associados.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await page.getByRole("button", { name: "Gerar prévia" }).click();
    await expect(page.getByText("Arquivo pronto para entrar")).toBeVisible();
    await page.getByRole("button", { name: "Confirmar importação" }).click();
    await expect(page.getByRole("heading", { name: "Importação concluída" })).toBeVisible();
    page.on("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Desfazer último lote" }).click();
    await expect(page.getByText(/Lote \d+ revertido com 1 item/)).toBeVisible();
    const db = await mysql.createConnection(dbUrl!); const [rows] = await db.execute("SELECT id FROM customers WHERE documentNumber='99100100199'"); await db.end();
    expect(rows).toEqual([]);
  });

  test("gera XLSX e PDF reais a partir do funil persistido", async ({ page }) => {
    await page.goto("/");
    await page.locator(".recharts-bar-rectangle").nth(2).click();
    await expect(page.getByRole("button", { name: "Excel" })).toBeVisible();
    const xlsx = page.waitForEvent("download"); await page.getByRole("button", { name: "Excel" }).click();
    expect((await xlsx).suggestedFilename()).toMatch(/\.xlsx$/);
    const pdf = page.waitForEvent("download"); await page.getByRole("button", { name: "PDF" }).click();
    expect((await pdf).suggestedFilename()).toMatch(/\.pdf$/);
  });

  test("converte oferta, registra acompanhante e encerra reserva real", async ({ page }) => {
    await page.goto("/reservas");
    await page.getByRole("button", { name: "Check-in" }).click();
    await expect(page.getByText("Status da reserva atualizado.")).toBeVisible();
    await page.getByRole("button", { name: "Acompanhantes" }).click();
    await expect(page.getByText("E2E Acompanhante")).toBeVisible();
    await page.getByRole("button", { name: "Chegou" }).click();
    await expect(page.getByText("Presença do acompanhante atualizada.")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Ofertar vaga" }).click();
    await expect(page.getByText("Situação da fila atualizada.")).toBeVisible();
    await page.getByRole("button", { name: "Confirmar reserva" }).click();
    await page.getByRole("combobox").last().click();
    await page.getByText("E2E Resort · E2E-102 · até 4 hóspedes").click();
    await page.getByRole("button", { name: "Criar reserva confirmada" }).click();
    await expect(page.getByText("Oferta convertida em reserva confirmada.")).toBeVisible();
    await page.getByRole("button", { name: "Check-out" }).click();
    await expect(page.getByText("Status da reserva atualizado.")).toBeVisible();
    const db = await mysql.createConnection(dbUrl!); const [guest] = await db.execute("SELECT checkedInAt, checkedOutAt FROM reservation_guests WHERE fullName='E2E Acompanhante'"); await db.end();
    expect((guest as Array<{ checkedInAt: Date | null; checkedOutAt: Date | null }>)[0]?.checkedInAt).toBeTruthy();
    expect((guest as Array<{ checkedInAt: Date | null; checkedOutAt: Date | null }>)[0]?.checkedOutAt).toBeTruthy();
  });
});
