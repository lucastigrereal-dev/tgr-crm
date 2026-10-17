import { createHash } from "node:crypto";
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
  test("mantém a captação sem overflow horizontal no celular", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/captacao");
    await expect(page.getByRole("heading", { name: "Central de captação" })).toBeVisible();
    const geometry = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  });

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
      [`sc-entry:${createHash("sha256").update(saleId).digest("hex")}`],
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

  // P-05 (Piloto na sala): o administrativo enxerga no navegador o que a ponte do Sales criou: contrato, parcelas,
  // baixa manual, trilha de auditoria, painel de integrações (Financial desligado) e o estoque. Depende do teste anterior.
  test("a sala no navegador: contrato da ponte, baixa manual, auditoria, integrações e estoque", async ({ page }) => {
    const fx = fixture!;
    const saleId = `E2E-SALE-${fx.normalizedRunId}`;
    const [contract] = await queryDatabase<Array<{ id: number; number: string }>>(
      "SELECT id, number FROM contracts WHERE externalSource = 'sales-command' AND externalSaleId = ?", [saleId],
    );
    expect(contract).toBeDefined();

    // contrato criado pela ponte aparece na pasta contratual e abre com as parcelas
    await page.goto("/contratos");
    const row = page.locator("div", { hasText: fx.prefix + "Sales Command Cliente" }).filter({ has: page.getByRole("link", { name: contract!.number }) }).last();
    await expect(row).toContainText("R$ 28.900,00");
    await page.getByRole("link", { name: contract!.number }).click();
    await expect(page).toHaveURL(new RegExp(`/contratos/${contract!.id}$`));
    await expect(page.getByText("Parcelas", { exact: true })).toBeVisible();
    await expect(page.getByText("#1", { exact: true })).toBeVisible();
    await expect(page.getByText("#2", { exact: true })).toBeVisible();

    // baixa manual da parcela 2 pela régua do Financeiro
    await page.goto("/financeiro");
    const item = page.locator("div", { hasText: `${contract!.number} · Parcela 2 · vence` }).filter({ has: page.getByRole("button", { name: "Baixar" }) }).last();
    await expect(item).toContainText("R$ 1.800,00");
    const paid = waitForMutation(page, "finance.markInstallmentPaid");
    await item.getByRole("button", { name: "Baixar" }).click();
    await paid;
    await expect(page.getByText("Parcela baixada como paga.")).toBeVisible();
    const installment = await queryDatabase<Array<{ status: string; paidAmount: string }>>(
      "SELECT status, paidAmount FROM installments WHERE contractId = ? AND sequence = 2", [contract!.id],
    );
    expect(installment[0]).toMatchObject({ status: "paid", paidAmount: "1800.00" });

    // a trilha de auditoria mostra a formalização da ponte e a baixa
    await page.goto("/auditoria");
    await expect(page.getByRole("heading", { name: "Auditoria" })).toBeVisible();
    await expect(page.getByText(`Venda ${saleId} formalizada em cliente, oportunidade, proposta, contrato e 86 parcelas.`)).toBeVisible();
    await expect(page.getByText("Parcela 2 baixada como paga.")).toBeVisible();

    // painel de integrações: Financial desligado (piloto) sem evento recusado
    await page.goto("/integracoes");
    await expect(page.getByRole("heading", { name: "Integrações" })).toBeVisible();
    const financialCard = page.locator(".rounded-xl", { has: page.getByText("TGR Financial Layer", { exact: true }) }).first();
    await expect(financialCard).toBeVisible();
    await expect(financialCard.getByText("Desligada")).toBeVisible();
    await expect(page.getByText("Nenhum evento recusado.")).toBeVisible();

    // estoque: as 2 cotas vendidas saíram do disponível
    await page.goto("/estoque-comercial");
    await expect(page.getByText(fx.resortName).first()).toBeVisible();
    await expect(page.getByText("Estoque comercial de cotas")).toBeVisible();
    const counter = (label: string) => page.locator("p.uppercase", { hasText: new RegExp(`^${label}$`) }).first().locator("xpath=following-sibling::p");
    await expect(counter("Total")).toHaveText("2");
    await expect(counter("Vendida")).toHaveText("2");
    await expect(counter("Disponível")).toHaveText("0");
  });

  // PK-17: telas do fluxo comercial no navegador: cadastro de cliente e portões de validação da venda (sem forjar assinatura).
  test("cadastra cliente pela tela e confirma o pagamento nos portões da venda, sem validar enquanto faltam assinatura e gerente", async ({ page }) => {
    const fx = fixture!;
    const fullName = `${fx.prefix}Cliente Tela`;

    await page.goto("/clientes");
    await page.getByRole("button", { name: "Novo cliente" }).click();
    await page.getByPlaceholder("Nome do associado").fill(fullName);
    await page.locator('input[name="phone"]').fill("(84) 99999-0101");
    await page.locator('input[name="email"]').fill(`tela.${fx.normalizedRunId}@exemplo.invalid`);
    const created = waitForMutation(page, "customers.create");
    await page.getByRole("button", { name: /^Salvar/ }).click();
    await created;
    await expect(page.getByText("Cliente salvo no CRM.")).toBeVisible();
    await expect(page.getByText(fullName).first()).toBeVisible();
    const customerRows = await queryDatabase<Array<{ id: number; fullName: string }>>(
      "SELECT id, fullName FROM customers WHERE fullName = ?", [fullName],
    );
    expect(customerRows).toHaveLength(1);

    // detalhe do cliente abre pela lista
    await page.getByText(fullName).first().click();
    await expect(page).toHaveURL(new RegExp(`/clientes/${customerRows[0]!.id}$`));
    await expect(page.getByRole("heading", { name: fullName })).toBeVisible();

    // contrato da ponte do Sales: portões pendentes, confirma pagamento, e a venda NÃO valida sem assinatura
    const saleId = `E2E-SALE-${fx.normalizedRunId}`;
    const [contract] = await queryDatabase<Array<{ id: number }>>(
      "SELECT id FROM contracts WHERE externalSource = 'sales-command' AND externalSaleId = ?", [saleId],
    );
    expect(contract).toBeDefined();
    await page.goto(`/contratos/${contract!.id}`);
    await expect(page.getByText("Portões de validação")).toBeVisible();
    await expect(page.getByTestId("gate-paymentConfirmed").getByLabel("pendente")).toBeVisible();
    await expect(page.getByTestId("gate-contractSigned").getByLabel("pendente")).toBeVisible();
    await expect(page.getByRole("button", { name: "Validar venda" })).toBeDisabled();

    await page.getByRole("button", { name: "Confirmar pagamento" }).click();
    await page.getByLabel("Nota de conferência").fill("Pagamento conferido no laboratório isolado.");
    const confirmed = waitForMutation(page, "saleValidation.confirmPayment");
    await page.getByRole("button", { name: "Confirmar", exact: true }).click();
    await confirmed;
    await expect(page.getByText("Pagamento confirmado.")).toBeVisible();
    await expect(page.getByTestId("gate-paymentConfirmed").getByLabel("atendido")).toBeVisible();
    await expect(page.getByTestId("gate-contractSigned").getByLabel("pendente")).toBeVisible();
    await expect(page.getByRole("button", { name: "Validar venda" })).toBeDisabled();
    await expect(page.getByTestId("gate-managerValidated").getByLabel("pendente")).toBeVisible();

    const validation = await queryDatabase<Array<{ paymentConfirmedAt: Date | null; paymentConfirmationNote: string | null }>>(
      "SELECT paymentConfirmedAt, paymentConfirmationNote FROM sale_validations WHERE contractId = ?", [contract!.id],
    );
    expect(validation[0]?.paymentConfirmedAt).not.toBeNull();
    expect(validation[0]?.paymentConfirmationNote).toBe("Pagamento conferido no laboratório isolado.");
    const [contractRow] = await queryDatabase<Array<{ status: string }>>("SELECT status FROM contracts WHERE id = ?", [contract!.id]);
    expect(contractRow!.status).toBe("pending_signature");
  });

  test("solicita, aprova e executa distrato uma única vez", async ({ page }) => {
    const contractId = process.env.E2E_CANCELLATION_CONTRACT_ID;
    test.skip(
      !contractId,
      "Requer E2E_CANCELLATION_CONTRACT_ID apontando para contrato descartável.",
    );
    await page.goto(`/contratos/${contractId}`);
    await page
      .getByRole("button", { name: "Pedir distrato" })
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

    // efeitos do distrato: parcela paga preservada, abertas canceladas, comissão pendente cancelada, paga preservada, cota devolvida ao estoque
    const installmentRows = await queryDatabase<Array<{ sequence: number; status: string }>>(
      "SELECT sequence, status FROM installments WHERE contractId = ? ORDER BY sequence", [Number(contractId)],
    );
    expect(installmentRows).toEqual([{ sequence: 1, status: "paid" }, { sequence: 2, status: "cancelled" }, { sequence: 3, status: "cancelled" }]);
    const commissionRows = await queryDatabase<Array<{ commissionRole: string; status: string; reversalReviewStatus: string | null }>>(
      "SELECT commissionRole, status, reversalReviewStatus FROM sales_commissions WHERE contractId = ?", [Number(contractId)],
    );
    expect(commissionRows).toHaveLength(2);
    expect(commissionRows.map(r => ({ commissionRole: r.commissionRole, status: r.status }))).toEqual(expect.arrayContaining([{ commissionRole: "closer", status: "cancelled" }, { commissionRole: "liner", status: "paid" }]));
    // comissão já paga vai pra revisão manual de estorno
    expect(commissionRows.find(r => r.commissionRole === "liner")?.reversalReviewStatus).toBe("pending");
    const fractionRows = await queryDatabase<Array<{ status: string; currentContractId: number | null }>>(
      "SELECT status, currentContractId FROM commercial_fractions WHERE code = ?", [`${fixture!.unitGuestCode}-D01`],
    );
    expect(fractionRows).toEqual([{ status: "available", currentContractId: null }]);
  });
  test("documentos: confirma a assinatura do documento do contrato pela tela, com auditoria e evento", async ({ page }) => {
    const fx = fixture!;
    const saleId = `E2E-SALE-${fx.normalizedRunId}`;
    const [contract] = await queryDatabase<Array<{ id: number }>>(
      "SELECT id FROM contracts WHERE externalSource = 'sales-command' AND externalSaleId = ?", [saleId],
    );
    expect(contract).toBeDefined();
    const filename = `${fx.prefix}contrato-assinatura.pdf`;
    await queryDatabase(
      "INSERT INTO contract_documents (contractId, category, filename, storageKey, signed, signedArtifact) VALUES (?, 'contrato', ?, ?, 0, 0)",
      [contract!.id, filename, `e2e/${fx.normalizedRunId}/contrato-assinatura.pdf`],
    );

    await page.goto(`/contratos/${contract!.id}`);
    await expect(page.getByText(filename)).toBeVisible();
    await expect(page.getByText(/aguardando assinatura/)).toBeVisible();
    await expect(page.getByTestId("gate-contractSigned").getByLabel("pendente")).toBeVisible();

    const signed = waitForMutation(page, "contracts.markDocumentSigned");
    await page.getByRole("button", { name: "Confirmar manualmente" }).click();
    await signed;
    await expect(page.getByText(/assinatura confirmada \(falta enviar o arquivo assinado\)/)).toBeVisible();
    // ADR-007: confirmação manual é só exibição; sem o arquivo assinado real, o portão da assinatura não abre e a venda não valida.
    // Recarrega a tela pra o portão vir do servidor, não de cache.
    await page.reload();
    await expect(page.getByText(/assinatura confirmada \(falta enviar o arquivo assinado\)/)).toBeVisible();
    await expect(page.getByTestId("gate-contractSigned").getByLabel("pendente")).toBeVisible();
    await expect(page.getByRole("button", { name: "Validar venda" })).toBeDisabled();

    const [doc] = await queryDatabase<Array<{ id: number; signed: number; signedArtifact: number }>>(
      "SELECT id, signed, signedArtifact FROM contract_documents WHERE contractId = ? AND filename = ?", [contract!.id, filename],
    );
    expect(doc).toMatchObject({ signed: 1, signedArtifact: 0 });
    const audit = await queryDatabase<Array<{ action: string }>>(
      "SELECT action FROM audit_logs WHERE entityType = 'contract_document' AND entityId = ? AND action = 'signed'", [String(doc!.id)],
    );
    expect(audit).toHaveLength(1);
    const events = await queryDatabase<Array<{ eventName: string }>>(
      "SELECT eventName FROM domain_events WHERE aggregateType = 'contract_document' AND aggregateId = ? AND eventName = 'contract.document.signed'", [String(doc!.id)],
    );
    expect(events).toHaveLength(1);
    const [contractRow] = await queryDatabase<Array<{ status: string; signedAt: Date | null }>>("SELECT status, signedAt FROM contracts WHERE id = ?", [contract!.id]);
    expect(contractRow!.status).toBe("pending_signature");
    expect(contractRow!.signedAt).toBeNull();
  });

  test("pontos: credita o ano, lança uso e confere o saldo no extrato", async ({ page }) => {
    const fx = fixture!;
    const saleId = `E2E-SALE-${fx.normalizedRunId}`;
    const [contract] = await queryDatabase<Array<{ id: number }>>(
      "SELECT id FROM contracts WHERE externalSource = 'sales-command' AND externalSaleId = ?", [saleId],
    );
    expect(contract).toBeDefined();
    await queryDatabase(
      "INSERT INTO ownership_entitlements (contractId, entitlementType, annualPoints, status) VALUES (?, 'points', 1000, 'active')",
      [contract!.id],
    );
    const [entitlement] = await queryDatabase<Array<{ id: number }>>(
      "SELECT id FROM ownership_entitlements WHERE contractId = ? AND entitlementType = 'points'", [contract!.id],
    );

    await page.goto(`/contratos/${contract!.id}`);
    await expect(page.getByText("Direitos de uso")).toBeVisible();
    await page.getByRole("button", { name: "Extrato de pontos" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Nenhum lançamento ainda.")).toBeVisible();

    const credited = waitForMutation(page, "pointsLedger.creditAnnual");
    await dialog.getByRole("button", { name: /Creditar/ }).click();
    await credited;
    await expect(dialog.getByText("+1000")).toBeVisible();
    await expect(dialog.getByText(/Disponível:/).locator("strong")).toHaveText("1000");

    await dialog.getByLabel("Pontos").fill("250");
    await dialog.getByPlaceholder("Observação ou motivo").fill("Uso de laboratório E2E");
    const used = waitForMutation(page, "pointsLedger.recordUsage");
    await dialog.getByRole("button", { name: "Lançar uso" }).click();
    await used;
    await expect(dialog.getByText("-250")).toBeVisible();
    await expect(dialog.getByText(/Disponível:/).locator("strong")).toHaveText("750");

    const ledger = await queryDatabase<Array<{ entryType: string; points: number }>>(
      "SELECT entryType, points FROM points_ledger WHERE entitlementId = ? ORDER BY id", [entitlement!.id],
    );
    expect(ledger).toEqual([{ entryType: "annual_credit", points: 1000 }, { entryType: "usage", points: -250 }]);
  });

  test("portal do proprietário: admin gera o link, o associado vê contrato e parcelas, e o link revogado para de abrir", async ({ page }) => {
    const fx = fixture!;
    const saleId = `E2E-SALE-${fx.normalizedRunId}`;
    const [contract] = await queryDatabase<Array<{ id: number; number: string; customerId: number }>>(
      "SELECT id, number, customerId FROM contracts WHERE externalSource = 'sales-command' AND externalSaleId = ?", [saleId],
    );
    expect(contract).toBeDefined();

    await page.goto(`/clientes/${contract!.customerId}`);
    await expect(page.getByText("Portal do associado")).toBeVisible();
    const created = waitForMutation(page, "ownerPortal.createLink");
    await page.getByRole("button", { name: "Gerar link" }).click();
    await created;
    await expect(page.getByText("Copie agora: este link não aparece de novo.")).toBeVisible();
    const url = await page.locator('input[readonly]').first().inputValue();
    expect(url).toMatch(/\/portal\/[A-Za-z0-9_-]{43}$/);

    // o associado abre o link sem sessão: contexto novo, sem cookie do admin
    const browser = page.context().browser()!;
    const token = url.split("/portal/")[1]!;
    const guest = await browser.newContext();
    try {
      const guestPage = await guest.newPage();
      await guestPage.goto(url);
      await expect(guestPage.getByRole("heading", { name: /^Olá,/ })).toBeVisible();
      await expect(guestPage.getByText(`Contrato ${contract!.number}`)).toBeVisible();
      await expect(guestPage.getByText(/Parcela 1 ·/).first()).toBeVisible();
      // só o hash fica no banco, e o link nasce ativo
      const linksBefore = await queryDatabase<Array<{ tokenHash: string; revokedAt: Date | null }>>(
        "SELECT tokenHash, revokedAt FROM owner_portal_links WHERE customerId = ?", [contract!.customerId],
      );
      expect(linksBefore).toHaveLength(1);
      expect(linksBefore[0]!.tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
      expect(linksBefore[0]!.revokedAt).toBeNull();

      const revoked = waitForMutation(page, "ownerPortal.revokeLink");
      await page.getByRole("button", { name: "Revogar" }).click();
      await revoked;
      const linksAfter = await queryDatabase<Array<{ revokedAt: Date | null }>>(
        "SELECT revokedAt FROM owner_portal_links WHERE customerId = ?", [contract!.customerId],
      );
      expect(linksAfter[0]!.revokedAt).not.toBeNull();
      await guestPage.reload();
      await expect(guestPage.getByRole("heading", { name: "Link indisponível" })).toBeVisible();
    } finally {
      await guest.close();
    }

    // link inventado também não abre
    const fake = await browser.newContext();
    try {
      const fakePage = await fake.newPage();
      await fakePage.goto(new URL("/portal/" + "A".repeat(43), url).toString());
      await expect(fakePage.getByRole("heading", { name: "Link indisponível" })).toBeVisible();
    } finally {
      await fake.close();
    }
  });
  test("ficha impressa: liga o código do casal, mostra o QR, registra impressão e reimpressão e monta a equipe", async ({ page }) => {
    const code = `FICHA-${Date.now().toString(36)}`;
    const [customer] = await queryDatabase<Array<{ id: number }>>("SELECT id FROM customers ORDER BY id LIMIT 1");
    const inserted = await queryDatabase<{ insertId: number }>(
      "INSERT INTO capture_records (customerId, salesRoom, presentationStatus, qualificationStatus, childrenCount) VALUES (?, 'Sala ficha E2E', 'captured', 'pending', 0)", [customer!.id],
    );
    const captureId = inserted.insertId;
    await page.addInitScript(() => { (window as unknown as { __printed: number }).__printed = 0; window.print = () => { (window as unknown as { __printed: number }).__printed += 1; }; });

    await page.goto(`/ficha?captura=${captureId}`);
    await expect(page.getByText("Esta ficha ainda não tem o código do casal.")).toBeVisible();
    const linked = waitForMutation(page, "captureSheet.setCoupleCode");
    await page.getByLabel("Código do casal").fill(code);
    await page.getByRole("button", { name: "Ligar à ficha" }).click();
    await linked;
    await expect(page.getByRole("img", { name: `QR da ficha ${code}` })).toBeVisible();
    await expect(page.getByText("Ainda não impressa.")).toBeVisible();

    const printed = waitForMutation(page, "captureSheet.recordPrint");
    await page.getByRole("button", { name: "Imprimir ficha" }).click();
    await printed;
    await expect(page.getByText("Impressa 1x.")).toBeVisible();
    const reprinted = waitForMutation(page, "captureSheet.recordPrint");
    await page.getByRole("button", { name: "Reimprimir ficha" }).click();
    await reprinted;
    await expect(page.getByText("Impressa 2x.")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(2);
    const prints = await queryDatabase<Array<{ reprint: number }>>("SELECT reprint FROM capture_sheet_prints WHERE captureId = ? ORDER BY id", [captureId]);
    expect(prints.map(row => Number(row.reprint))).toEqual([0, 1]);

    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Motorista" }).click();
    await page.getByLabel("Nome da pessoa").fill("Motorista E2E");
    const assigned = waitForMutation(page, "captureSheet.team.set");
    await page.getByRole("button", { name: "Atribuir" }).click();
    await assigned;
    await expect(page.locator("#ficha-print").getByText("Motorista E2E")).toBeVisible();
    const members = await queryDatabase<Array<{ personName: string }>>("SELECT personName FROM capture_team_members WHERE captureId = ?", [captureId]);
    expect(members.map(row => row.personName)).toEqual(["Motorista E2E"]);

    // código inexistente não abre ficha nenhuma
    await page.goto("/ficha?codigo=NAO-EXISTE-1");
    await expect(page.getByText("Ficha não encontrada")).toBeVisible();
  });
});
