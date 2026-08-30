import { expect, test } from "@playwright/test";
import mysql from "mysql2/promise";
import { getE2EFixture } from "../shared/e2eFixture";

const strict = process.env.E2E_STRICT === "1";
const dbUrl = process.env.E2E_DATABASE_URL;
const fixture = strict && dbUrl ? getE2EFixture() : undefined;
test.skip(!strict || !dbUrl, "Requer E2E_STRICT=1 e E2E_DATABASE_URL isolada.");

async function queryDatabase<T>(sql: string, params: unknown[] = []) {
  const db = await mysql.createConnection(dbUrl!);
  try {
    const [rows] = await db.execute(sql, params);
    return rows as T;
  } finally {
    await db.end();
  }
}

function waitForMutation(page: import("@playwright/test").Page, procedure: string) {
  return page.waitForResponse(
    response =>
      response.request().method() === "POST" &&
      response.ok() &&
      response.url().includes(`/api/trpc/${procedure}`),
  );
}

test.describe("homologação isolada estrita", () => {
  test("importa e reverte CSV no backend real", async ({ page }) => {
    const fx = fixture!;
    const csv = [
      "nome_completo;documento;email;telefone;cidade;uf;status",
      `${fx.importCustomerName};${fx.documents.imported};${fx.normalizedRunId}.importado@e2e.invalid;${fx.phones.imported};Natal;RN;ativo`,
    ].join("\n");

    await page.goto("/importar");
    await page.locator('input[type="file"]').setInputFiles({
      name: `${fx.normalizedRunId}-associados.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.getByRole("button", { name: "Gerar prévia" }).click();
    await expect(page.getByText("Arquivo pronto para entrar")).toBeVisible();
    await page.getByRole("button", { name: "Confirmar importação" }).click();
    await expect(page.getByRole("heading", { name: "Importação concluída" })).toBeVisible();
    page.on("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Desfazer último lote" }).click();
    await expect(page.getByText(/Lote \d+ revertido com 1 item/)).toBeVisible();

    const rows = await queryDatabase<unknown[]>(
      "SELECT id FROM customers WHERE documentNumber = ?",
      [fx.documents.imported],
    );
    expect(rows).toEqual([]);
  });

  test("gera XLSX e PDF reais a partir do funil persistido", async ({ page }) => {
    await page.goto("/");
    await page.locator(".recharts-bar-rectangle").nth(2).click();
    await expect(page.getByRole("button", { name: "Excel" })).toBeVisible();
    const xlsx = page.waitForEvent("download");
    await page.getByRole("button", { name: "Excel" }).click();
    expect((await xlsx).suggestedFilename()).toMatch(/\.xlsx$/);
    const pdf = page.waitForEvent("download");
    await page.getByRole("button", { name: "PDF" }).click();
    expect((await pdf).suggestedFilename()).toMatch(/\.pdf$/);
  });

  test("converte oferta, registra acompanhante e encerra reserva real", async ({ page }) => {
    const fx = fixture!;
    await page.goto("/reservas");
    const checkIn = waitForMutation(page, "operations.updateReservationStatus");
    await page.getByRole("button", { name: "Check-in" }).click();
    await checkIn;
    await expect(page.getByText("Status da reserva atualizado.")).toBeVisible();
    await page.getByRole("button", { name: "Acompanhantes" }).click();
    await expect(page.getByText(fx.guestName)).toBeVisible();
    const guestCheckIn = waitForMutation(page, "operations.updateGuestPresence");
    await page.getByRole("button", { name: "Chegou" }).click();
    await guestCheckIn;
    await expect(page.getByText("Presença do acompanhante atualizada.")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Ofertar vaga" }).click();
    await expect(page.getByText("Situação da fila atualizada.")).toBeVisible();
    await page.getByRole("button", { name: "Confirmar reserva" }).click();
    await page.getByRole("combobox").last().click();
    await page
      .getByText(`${fx.resortName} · ${fx.unitWaitlistCode} · até 4 hóspedes`)
      .click();
    await page.getByRole("button", { name: "Criar reserva confirmada" }).click();
    await expect(page.getByText("Oferta convertida em reserva confirmada.")).toBeVisible();
    const checkOut = waitForMutation(page, "operations.updateReservationStatus");
    await page.getByRole("button", { name: "Check-out" }).click();
    await checkOut;

    const guests = await queryDatabase<
      Array<{ checkedInAt: Date | null; checkedOutAt: Date | null }>
    >(
      "SELECT checkedInAt, checkedOutAt FROM reservation_guests WHERE fullName = ?",
      [fx.guestName],
    );
    expect(guests[0]?.checkedInAt).toBeTruthy();
    expect(guests[0]?.checkedOutAt).toBeTruthy();
  });

  test("opera a sala real: chegada, mesa, time, tour encerrado e sem-tour", async ({ page }) => {
    const fx = fixture!;
    await page.goto("/sala-de-vendas");
    const tourCard = page
      .getByTestId("room-card")
      .filter({ hasText: fx.roomTourCustomerName });
    await expect(tourCard).toBeVisible();
    await tourCard.getByRole("button", { name: "Confirmar chegada" }).click();
    await expect(tourCard.getByLabel("Mesa")).toBeVisible();
    await tourCard.getByLabel("Mesa").fill(fx.salesTable);
    await tourCard.getByRole("combobox").nth(0).click();
    await page.getByRole("option", { name: fx.ownerName }).click();
    await tourCard.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: fx.ownerName }).click();
    await tourCard.getByRole("button", { name: "Salvar mesa" }).click();
    await tourCard.getByRole("button", { name: "Iniciar tour" }).click();
    await expect(
      tourCard.getByRole("button", { name: "Encerrar apresentação" }),
    ).toBeVisible();
    await tourCard.getByRole("button", { name: "Encerrar apresentação" }).click();
    await expect(tourCard).toHaveCount(0);

    const noTourCard = page
      .getByTestId("room-card")
      .filter({ hasText: fx.roomNoTourCustomerName });
    await noTourCard.getByRole("button", { name: "Registrar sem-tour" }).click();
    await noTourCard
      .getByLabel("Motivo do sem-tour *")
      .fill("Casal desistiu da apresentação no teste isolado.");
    await noTourCard.getByRole("button", { name: "Confirmar sem-tour" }).click();
    await expect(noTourCard).toHaveCount(0);

    const records = await queryDatabase<
      Array<{
        fullName: string;
        presentationStatus: string;
        salesTable: string | null;
        linerId: number | null;
        closerId: number | null;
        presentationStartedAt: Date | null;
        presentationEndedAt: Date | null;
        noTourReason: string | null;
      }>
    >(
      "SELECT c.fullName, cr.presentationStatus, cr.salesTable, cr.linerId, cr.closerId, cr.presentationStartedAt, cr.presentationEndedAt, cr.noTourReason FROM capture_records cr JOIN customers c ON c.id = cr.customerId WHERE c.documentNumber IN (?, ?) ORDER BY c.documentNumber",
      [fx.documents.roomTour, fx.documents.roomNoTour],
    );
    const tour = records.find(record => record.fullName === fx.roomTourCustomerName);
    const noTour = records.find(
      record => record.fullName === fx.roomNoTourCustomerName,
    );
    expect(tour).toMatchObject({
      presentationStatus: "closed",
      salesTable: fx.salesTable,
    });
    expect(tour?.linerId).toBeTruthy();
    expect(tour?.closerId).toBeTruthy();
    expect(tour?.presentationStartedAt).toBeTruthy();
    expect(tour?.presentationEndedAt).toBeTruthy();
    expect(noTour).toMatchObject({
      presentationStatus: "no_tour",
      noTourReason: "Casal desistiu da apresentação no teste isolado.",
    });
  });

  test("solicita, aprova e executa distrato uma única vez", async ({ page }) => {
    const contractId = process.env.E2E_CANCELLATION_CONTRACT_ID;
    test.skip(
      !contractId,
      "Requer E2E_CANCELLATION_CONTRACT_ID apontando para contrato descartável.",
    );
    await page.goto(`/contratos/${contractId}`);
    await page
      .getByRole("button", { name: "Solicitar revisão de distrato" })
      .click();
    await page
      .getByPlaceholder("Motivo documentado do distrato")
      .fill("Distrato solicitado no laboratório isolado.");
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    await expect(page.getByText(/Solicitação #/)).toBeVisible();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(
      page.getByRole("button", { name: "Executar distrato aprovado" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Executar distrato aprovado" })
      .click();
    await expect(
      page.getByText("Distrato aprovado executado com trilha auditável."),
    ).toBeVisible();

    const rows = await queryDatabase<Array<{ status: string }>>(
      "SELECT status FROM contracts WHERE id = ?",
      [Number(contractId)],
    );
    expect(rows[0]?.status).toBe("cancelled");
  });
});
