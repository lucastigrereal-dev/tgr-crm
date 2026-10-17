import { describe, expect, it } from "vitest";
import { addCalendarDays, canOpenArchivedSheet, localDayStart, paperCustody, privacyNoticeText, roomVisibility } from "./captureSheetDomain";
import { buildCaptureExportFilename, buildCaptureExportRows, csvCell, toCsv } from "../shared/captureSheetExport";
import { localDateInTimezone } from "./saleTermsPolicy";

// LGPD da ficha (parecer 17/10 + decisões do Lucas 16:14Z): regras puras, sem banco.
describe("vista da sala: ficha de quem não comprou sai depois do dia da visita", () => {
  it("no dia da visita a sala vê; no dia seguinte só o administrativo (0 dias extras)", () => {
    expect(roomVisibility({ visitDay: "2026-10-17", today: "2026-10-17", roomVisibilityDays: 0, commercialOutcome: null })).toMatchObject({ visibleToRoom: true, reason: "dia_da_visita", lastRoomDay: "2026-10-17" });
    expect(roomVisibility({ visitDay: "2026-10-17", today: "2026-10-18", roomVisibilityDays: 0, commercialOutcome: null })).toMatchObject({ visibleToRoom: false, reason: "arquivada" });
    expect(roomVisibility({ visitDay: "2026-10-17", today: "2026-10-18", roomVisibilityDays: 0, commercialOutcome: "caiu_em_mesa" })).toMatchObject({ visibleToRoom: false });
  });
  it("VENDEU mantém a ficha visível; dias extras configuráveis empurram o corte; dia inválido ou negativo vale 0", () => {
    expect(roomVisibility({ visitDay: "2026-01-01", today: "2026-12-31", roomVisibilityDays: 0, commercialOutcome: "vendeu" })).toMatchObject({ visibleToRoom: true, reason: "vendeu" });
    expect(roomVisibility({ visitDay: "2026-10-17", today: "2026-10-20", roomVisibilityDays: 3, commercialOutcome: null })).toMatchObject({ visibleToRoom: true, lastRoomDay: "2026-10-20" });
    expect(roomVisibility({ visitDay: "2026-10-17", today: "2026-10-21", roomVisibilityDays: 3, commercialOutcome: null })).toMatchObject({ visibleToRoom: false });
    expect(roomVisibility({ visitDay: "2026-10-17", today: "2026-10-18", roomVisibilityDays: -5, commercialOutcome: null })).toMatchObject({ visibleToRoom: false });
    expect(roomVisibility({ visitDay: "2026-10-17", today: "2026-10-18", roomVisibilityDays: Number.NaN, commercialOutcome: null })).toMatchObject({ visibleToRoom: false });
    expect(roomVisibility({ visitDay: null, today: "2026-10-18", roomVisibilityDays: 0, commercialOutcome: null })).toMatchObject({ visibleToRoom: true });
  });
  it("só admin e finance abrem a ficha arquivada", () => {
    expect(canOpenArchivedSheet("admin")).toBe(true);
    expect(canOpenArchivedSheet("finance")).toBe(true);
    for (const role of ["seller", "service", "user", null, undefined, ""]) expect(canOpenArchivedSheet(role)).toBe(false);
  });
  it("aritmética de calendário atravessa mês e ano", () => {
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("início do dia local em Recife (UTC-3) e num fuso de meia hora", () => {
    expect(localDayStart("2026-10-17", "America/Recife", localDateInTimezone).toISOString()).toBe("2026-10-17T03:00:00.000Z");
    expect(localDayStart("2026-10-17", "Asia/Kolkata", localDateInTimezone).toISOString()).toBe("2026-10-16T18:30:00.000Z");
    expect(localDayStart("2026-10-17", "UTC", localDateInTimezone).toISOString()).toBe("2026-10-17T00:00:00.000Z");
  });
});

describe("custódia do papel", () => {
  const printedDay = "2026-10-17";
  it("em circulação até recolher, recolhida até destruir, destruída fecha; prazo 0 = no mesmo dia", () => {
    expect(paperCustody({ printedDay: null, collectedAt: null, destroyedAt: null, today: printedDay, destroyDeadlineDays: 0 })).toMatchObject({ status: "nao_impressa", overdue: false });
    expect(paperCustody({ printedDay, collectedAt: null, destroyedAt: null, today: printedDay, destroyDeadlineDays: 0 })).toMatchObject({ status: "em_circulacao", overdue: false, deadlineDay: printedDay });
    expect(paperCustody({ printedDay, collectedAt: new Date(), destroyedAt: null, today: printedDay, destroyDeadlineDays: 0 })).toMatchObject({ status: "recolhida", overdue: false });
    expect(paperCustody({ printedDay, collectedAt: null, destroyedAt: null, today: "2026-10-18", destroyDeadlineDays: 0 })).toMatchObject({ status: "em_circulacao", overdue: true });
    expect(paperCustody({ printedDay, collectedAt: new Date(), destroyedAt: null, today: "2026-10-18", destroyDeadlineDays: 0 })).toMatchObject({ status: "recolhida", overdue: true });
    expect(paperCustody({ printedDay, collectedAt: new Date(), destroyedAt: new Date(), today: "2026-11-30", destroyDeadlineDays: 0 })).toMatchObject({ status: "destruida", overdue: false });
  });
  it("prazo de 7 dias: atrasa só no oitavo", () => {
    expect(paperCustody({ printedDay, collectedAt: null, destroyedAt: null, today: "2026-10-24", destroyDeadlineDays: 7 })).toMatchObject({ overdue: false, deadlineDay: "2026-10-24" });
    expect(paperCustody({ printedDay, collectedAt: null, destroyedAt: null, today: "2026-10-25", destroyDeadlineDays: 7 })).toMatchObject({ overdue: true });
  });
});

describe("aviso de privacidade v1 (provisório)", () => {
  it("campo vazio sai como marcador, nunca inventado; preenchido entra no texto; a palavra consentimento não aparece", () => {
    const empty = privacyNoticeText({});
    expect(empty).toContain("[RAZÃO SOCIAL DA OPERADORA]");
    expect(empty).toContain("CNPJ [●]");
    expect(empty).toContain("[canal do encarregado]");
    expect(empty.toLowerCase()).not.toContain("consent");
    expect(empty).toContain("no fim do dia da visita");
    expect(privacyNoticeText({}, 3)).toContain("em até 3 dias depois do dia da visita");
    expect(privacyNoticeText({}, 3)).not.toContain("no fim do dia da visita");
    expect(privacyNoticeText({}, 1)).toContain("em até 1 dia depois do dia da visita");
    const filled = privacyNoticeText({ privacy_controller_name: " Operadora Exemplo Ltda ", privacy_controller_cnpj: "00.000.000/0001-00", privacy_contact_channel: "privacidade@exemplo.test", privacy_retention_text: "5 anos", privacy_full_text_url: "exemplo.test/privacidade" });
    expect(filled).toContain("tratados por Operadora Exemplo Ltda, CNPJ 00.000.000/0001-00");
    expect(filled).toContain("pelo prazo de 5 anos");
    expect(filled).not.toContain("[●]");
  });
});

describe("exportação CSV/Excel das fichas", () => {
  const source = [{ captureId: 7, coupleCode: "CP-0007", createdAt: "2026-10-17T13:00:00Z", checkedInAt: null, salesRoom: "Sala; Norte", captureLocation: null, presentationStatus: "presented", qualificationStatus: "qualified", commercialOutcome: "caiu_em_mesa", customerName: 'Casal "Teste"', documentNumber: "00000000000", city: "Natal", state: "RN", partnerName: "=SOMA(1)", averageIncome: "8500.00", promoterName: "Promo", linerName: null, closerName: null }];
  it("CPF só entra quando pedido; coluna some por inteiro sem ele", () => {
    expect(Object.keys(buildCaptureExportRows(source, { withCpf: true })[0]!)).toContain("CPF");
    expect(Object.keys(buildCaptureExportRows(source, { withCpf: false })[0]!)).not.toContain("CPF");
    expect(toCsv(buildCaptureExportRows(source, { withCpf: false }))).not.toContain("00000000000");
  });
  it("CSV com BOM e ponto e vírgula, aspas escapadas, fórmula neutralizada e renda numérica", () => {
    const csv = toCsv(buildCaptureExportRows(source, { withCpf: true }));
    expect(csv.startsWith("﻿Ficha;Codigo_do_casal;")).toBe(true);
    expect(csv).toContain('"Sala; Norte"');
    expect(csv).toContain('"Casal ""Teste"""');
    expect(csv).toContain("'=SOMA(1)");
    expect(csv).toContain(";8500;");
    expect(toCsv([])).toBe("﻿");
    expect(csvCell(null)).toBe("");
    expect(csvCell("-1")).toBe("'-1");
  });
  it("nome do arquivo leva período, quem exportou (sem acento) e a hora", () => {
    expect(buildCaptureExportFilename("2026-10-01", "2026-10-17", "Gerência de Sala", "csv", new Date("2026-10-17T16:30:00Z"))).toBe("fichas-2026-10-01_a_2026-10-17-gerencia-de-sala-20261017T163000.csv");
    expect(buildCaptureExportFilename("2026-10-01", "2026-10-17", "   ", "xlsx", new Date("2026-10-17T16:30:00Z"))).toMatch(/-usuario-\d{8}T\d{6}\.xlsx$/);
  });
});
