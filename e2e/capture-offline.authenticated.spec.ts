import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";

// M-A15-02: prova da ficha de captação SEM INTERNET no navegador de verdade (Chromium com a rede desligada). Só a FICHA funciona offline; contrato, pagamento e venda não.
// Roda contra servidor + banco descartáveis (E2E_DATABASE_URL isolada). Ligar com E2E_CAPTURE_OFFLINE=1. Dados 100% sintéticos.
const dbUrl = process.env.E2E_DATABASE_URL;
test.skip(process.env.E2E_CAPTURE_OFFLINE !== "1" || !dbUrl, "Requer E2E_CAPTURE_OFFLINE=1 e E2E_DATABASE_URL isolada.");

const run = Math.random().toString(36).slice(2, 8);
async function countCaptures(name: string) {
  const db = await mysql.createConnection(dbUrl!);
  try {
    const [rows] = await db.execute("SELECT COUNT(*) AS n FROM capture_records c JOIN customers u ON u.id = c.customerId WHERE u.fullName = ?", [name]);
    return Number((rows as { n: number }[])[0]!.n);
  } finally { await db.end(); }
}
const queueLine = (page: import("@playwright/test").Page, name: string) => page.getByText(name).first();

test.describe("ficha de captação offline", () => {
  test("sem rede a ficha fica guardada no aparelho; com resposta perdida o reenvio não duplica; com sinal volta tudo e sobe uma ficha só", async ({ page, context }) => {
    const name = `Casal Offline ${run}`;
    await page.goto("/captacao");
    await expect(page.getByRole("heading", { name: "Central de captação" })).toBeVisible();

    // 1) rede desligada de verdade: preenche e envia
    await context.setOffline(true);
    await page.getByPlaceholder("Nome completo").fill(name);
    await page.getByRole("button", { name: /Lançar ficha/ }).click();
    await expect(page.getByText(/1 ficha na fila local/)).toBeVisible();
    await expect(page.getByText("Pendente de envio")).toBeVisible();
    expect(await countCaptures(name)).toBe(0);

    // 2) sinal "volta" mas a RESPOSTA do servidor se perde (o servidor grava, o celular não fica sabendo)
    let lostResponses = 0;
    await page.route("**/api/trpc/captures.create**", async route => {
      await route.fetch(); // o servidor processou e gravou
      lostResponses += 1;
      await route.abort("connectionreset"); // o celular nunca viu a resposta
    });
    await context.setOffline(false);
    await expect.poll(() => lostResponses, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => countCaptures(name), { timeout: 10_000 }).toBe(1);

    // 3) reabrir o app: a ficha continua na fila local (IndexedDB), ainda pendente — falha de rede NÃO a transforma em conflito
    await page.reload();
    await expect(page.getByText(/1 ficha na fila local/)).toBeVisible();
    await expect(queueLine(page, name)).toBeVisible();
    await expect(page.getByText(/Conflito/)).toHaveCount(0);

    // 4) sinal de verdade: sincronizar devolve a MESMA ficha (idempotente), esvazia a fila e não duplica
    await page.unroute("**/api/trpc/captures.create**");
    await page.getByRole("button", { name: /Sincronizar agora/ }).click();
    await expect(page.getByText(/ficha.* na fila local/)).toHaveCount(0, { timeout: 15_000 });
    expect(await countCaptures(name)).toBe(1);
  });
});
