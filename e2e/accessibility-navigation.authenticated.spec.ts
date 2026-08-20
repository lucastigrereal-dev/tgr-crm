import { expect, test } from "@playwright/test";

test.describe("navegação acessível autenticada", () => {
  test("permite pular a navegação lateral direto ao conteúdo principal", async ({ page }) => {
    await page.goto("/");
    const skipLink = page.getByRole("link", { name: "Pular para o conteúdo principal" });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#conteudo-principal")).toBeFocused();
  });
});
