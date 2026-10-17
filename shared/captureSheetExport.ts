/**
 * Exportação das fichas da sala em CSV e Excel (decisões 34 e 48 do Lucas; parecer LGPD M1).
 * O servidor decide o que sai (CPF só com `export.pii`) e grava a trilha com filtros e número de linhas;
 * aqui só mora a montagem do arquivo, para o teste cobrir sem navegador nem banco.
 */
import { presentationMinutes } from "./captureSheetReports";

export type CaptureExportSource = {
  captureId: number;
  coupleCode: string | null;
  createdAt: Date | string;
  checkedInAt: Date | string | null;
  salesRoom: string | null;
  captureLocation: string | null;
  presentationStatus: string;
  qualificationStatus: string;
  commercialOutcome: string | null;
  customerName: string;
  /** Só vem preenchido quando quem exportou tem `export.pii`; sem a capacidade o servidor manda nulo. */
  documentNumber: string | null;
  city: string | null;
  state: string | null;
  partnerName: string | null;
  averageIncome: number | string | null;
  promoterName: string | null;
  linerName: string | null;
  closerName: string | null;
  ntKind?: string | null;
  noTourReason?: string | null;
  presentationStartedAt?: Date | string | null;
  presentationEndedAt?: Date | string | null;
};

const dateTime = (value: Date | string | null, timeZone: string) => (value ? new Date(value).toLocaleString("pt-BR", { timeZone }) : "");

export function buildCaptureExportRows(rows: CaptureExportSource[], options: { withCpf: boolean; /** Fuso do projeto, o mesmo que o servidor usou para escolher o dia; sem ele vale Recife. */ timeZone?: string }) {
  const timeZone = options.timeZone || "America/Recife";
  return rows.map(row => ({
    Ficha: row.captureId,
    Codigo_do_casal: row.coupleCode ?? "",
    Criada_em: dateTime(row.createdAt, timeZone),
    Check_in: dateTime(row.checkedInAt, timeZone),
    Sala: row.salesRoom ?? "",
    Local_de_captacao: row.captureLocation ?? "",
    Status: row.presentationStatus,
    Qualificacao: row.qualificationStatus,
    Resultado_comercial: row.commercialOutcome ?? "",
    Titular: row.customerName,
    ...(options.withCpf ? { CPF: row.documentNumber ?? "" } : {}),
    Cidade: row.city ?? "",
    UF: row.state ?? "",
    Conjuge: row.partnerName ?? "",
    Renda_media: row.averageIncome == null || row.averageIncome === "" ? "" : Number(row.averageIncome),
    Promotor: row.promoterName ?? "",
    Consultor: row.linerName ?? "",
    Fechador: row.closerName ?? "",
    Tipo_NT: row.ntKind ?? "",
    Motivo_sem_tour: row.noTourReason ?? "",
    Inicio_apresentacao: dateTime(row.presentationStartedAt ?? null, timeZone),
    Fim_apresentacao: dateTime(row.presentationEndedAt ?? null, timeZone),
    Minutos_apresentacao: presentationMinutes(row.presentationStartedAt ?? null, row.presentationEndedAt ?? null) ?? "",
  }));
}

export type CaptureExportRow = ReturnType<typeof buildCaptureExportRows>[number];

/** Valor de célula CSV: aspas quando tem separador, aspas ou quebra de linha; aspas internas dobram. Fórmulas (=, +, -, @) ganham apóstrofo para o Excel não executar. */
export function csvCell(value: string | number | null | undefined) {
  if (value == null) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV com ponto e vírgula e BOM: abre certo no Excel em português sem assistente de importação. */
export function toCsv(rows: Array<Record<string, string | number>>) {
  if (!rows.length) return "﻿";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(";"), ...rows.map(row => headers.map(header => csvCell(row[header])).join(";"))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Nome do arquivo com período, quem exportou e a hora: a trilha e o arquivo contam a mesma história (parecer M1.c). */
export function buildCaptureExportFilename(from: string, to: string, actor: string, format: "csv" | "xlsx", now = new Date()) {
  const who = actor.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 40) || "usuario";
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `fichas-${from}_a_${to}-${who}-${stamp}.${format}`;
}

type ExcelJsWriter = { Workbook: new () => { addWorksheet: (name: string) => any; xlsx: { writeBuffer: () => Promise<ArrayBuffer> } } };

export async function writeCaptureExportXlsx(rows: CaptureExportRow[], exceljs: ExcelJsWriter) {
  const workbook = new exceljs.Workbook();
  const worksheet = workbook.addWorksheet("Fichas");
  const headers = rows.length ? Object.keys(rows[0]!) : ["Ficha"];
  worksheet.columns = headers.map(header => ({ header: header.replace(/_/g, " "), key: header, width: Math.max(12, Math.min(34, header.length + 6)) }));
  worksheet.addRows(rows);
  worksheet.getRow(1).font = { bold: true };
  return workbook.xlsx.writeBuffer();
}

export function downloadBlob(data: ArrayBuffer | string, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}
