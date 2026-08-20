import { expect, test } from "@playwright/test";

test.describe("reservas autenticadas", () => {
  test("abre a operação de reservas com fila e inventário disponíveis", async ({ page }) => {
    await page.goto("/reservas");
    await expect(page.getByRole("heading", { name: /Reservas & disponibilidade/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Inventário" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Lista de espera" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Nova reserva/i })).toBeVisible();
  });

  test("abre o formulário de lista de espera com vínculo contratual", async ({ page }) => {
    await page.goto("/reservas");
    await page.getByRole("button", { name: "Lista de espera" }).first().click();
    await expect(page.getByRole("heading", { name: /Entrar na lista de espera/i })).toBeVisible();
    await expect(page.getByText(/Contrato ativo aplica automaticamente/i)).toBeVisible();
  });
});
