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

  test("formaliza SALE_CONFIRMED do Sales Command em contrato, parcelas e estoque uma única vez", async ({ request }) => {
    const fx = fixture!;
    const baseUrl = process.env.E2E_BASE_URL!;
    const integrationKey = process.env.SALES_COMMAND_INTEGRATION_KEY!;
    const saleId = `E2E-SALE-${fx.normalizedRunId}`;
    const projectExternalKey = `E2E-SC-${fx.normalizedRunId}`;
    const saleDate = new Date().toISOString().slice(0, 10);
    const secondEntryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const body = {
      eventId: `evt-${saleId}`,
      eventName: "sale.ready_for_contract.v1",
      source: "sales-command",
      correlationId: `corr-${saleId}`,
      occurredAt: new Date().toISOString(),
      project: { externalKey: projectExternalKey, name: fx.resortName, timezone: "America/Recife" },
      saleId,
      encounterId: `enc-${fx.normalizedRunId}`,
      customer: { name: `${fx.prefix}Sales Command Cliente` },
      sale: {
        quotasCount: 2,
        vgvCents: 2_890_000,
        entryContractedCents: 360_000,
        entryReceivedCents: 180_000,
        entryInstallmentCount: 2,
        entrySchedule: [
          { sequence: 1, amountCents: 180_000, dueDate: saleDate },
          { sequence: 2, amountCents: 180_000, dueDate: secondEntryDate },
        ],
        firstBalanceDueInDays: 120,
        paymentMethods: ["PIX"],
      },
    };

    const first = await request.post(`${baseUrl}/api/integrations/sales-command`, {
      headers: { Authorization: `Bearer ${integrationKey}` },
      data: body,
    });
    expect(first.status()).toBe(201);
    const firstJson = await first.json();
    expect(firstJson).toMatchObject({ accepted: true, replay: false, saleId, installmentCount: 86 });
    expect(firstJson.fractionIds).toHaveLength(2);

    const contracts = await queryDatabase<Array<{ id: number; opportunityId: number; proposalId: number; status: string; externalSaleId: string }>>(
      "SELECT c.id, p.opportunityId, c.proposalId, c.status, c.externalSaleId FROM contracts c JOIN proposals p ON p.id = c.proposalId WHERE c.externalSource = 'sales-command' AND c.externalSaleId = ?",
      [saleId],
    );
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({ status: "pending_signature", externalSaleId: saleId });

    const installmentRows = await queryDatabase<Array<{ sequence: number; amount: string; paidAmount: string; status: string }>>(
      "SELECT sequence, amount, paidAmount, status FROM installments WHERE contractId = ? ORDER BY sequence",
      [contracts[0]!.id],
    );
    expect(installmentRows).toHaveLength(86);
    expect(installmentRows[0]).toMatchObject({ sequence: 1, amount: "1800.00", paidAmount: "1800.00", status: "paid" });
    expect(installmentRows[1]).toMatchObject({ sequence: 2, amount: "1800.00", paidAmount: "0.00", status: "open" });
    const contractualTotal = installmentRows.reduce((sum, row) => sum + Number(row.amount), 0);
    expect(contractualTotal).toBeCloseTo(28_900, 2);

    const fractionRows = await queryDatabase<Array<{ status: string; currentContractId: number }>>(
      "SELECT status, currentContractId FROM commercial_fractions WHERE currentContractId = ? ORDER BY id",
      [contracts[0]!.id],
    );
    expect(fractionRows).toHaveLength(2);
    expect(fractionRows.every(row => row.status === "sold")).toBe(true);

    const cashRows = await queryDatabase<Array<{ amount: string; status: string }>>(
      "SELECT amount, status FROM financial_transactions WHERE idempotencyKey = ?",
      [`sc-entry:${saleId}`],
    );
    expect(cashRows).toEqual([{ amount: "1800.00", status: "paid" }]);

    const resortRows = await queryDatabase<Array<{ externalKey: string | null }>>(
      "SELECT externalKey FROM resorts WHERE name = ?",
      [fx.resortName],
    );
    expect(resortRows[0]?.externalKey).toBe(projectExternalKey);

    const replay = await request.post(`${baseUrl}/api/integrations/sales-command`, {
      headers: { Authorization: `Bearer ${integrationKey}` },
      data: body,
    });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ accepted: true, replay: true, contractId: contracts[0]!.id, saleId });

    const afterReplay = await queryDatabase<Array<{ count: number | string }>>(
      "SELECT COUNT(*) AS count FROM contracts WHERE externalSource = 'sales-command' AND externalSaleId = ?",
      [saleId],
    );
    expect(Number(afterReplay[0]?.count ?? 0)).toBe(1);
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
