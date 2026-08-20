export const funnelExportStageLabels = {
  new: "Novas",
  qualified: "Qualificadas",
  proposal: "Proposta",
  negotiation: "Negociação",
  won: "Ganhos",
  lost: "Perdidos",
} as const;

export type FunnelExportStage = keyof typeof funnelExportStageLabels;

export type FunnelExportSource = {
  opportunity: {
    title: string;
    expectedAmount: number | string;
    probability: number;
    createdAt: Date | string;
  };
  customerName: string;
  sellerName: string | null;
};

export function buildFunnelExportRows(stage: FunnelExportStage, records: FunnelExportSource[]) {
  return records.map(({ opportunity, customerName, sellerName }) => ({
    Etapa: funnelExportStageLabels[stage],
    Proposta: opportunity.title,
    Associado: customerName,
    Vendedor: sellerName || "Não atribuído",
    Valor: Number(opportunity.expectedAmount),
    Probabilidade: `${opportunity.probability}%`,
    Criada_em: new Date(opportunity.createdAt).toLocaleDateString("pt-BR", { timeZone: "UTC" }),
  }));
}

export function buildFunnelExportFilename(stage: FunnelExportStage, startDate: string, endDate: string, format: "xlsx" | "pdf") {
  return `tse-propostas-${stage}-${startDate}-${endDate}.${format}`;
}

type ExcelJsWriter = {
  Workbook: new () => {
    addWorksheet: (name: string) => any;
    xlsx: { writeBuffer: () => Promise<ArrayBuffer> };
  };
};

type FunnelPdfDocument = {
  setFillColor: (red: number, green: number, blue: number) => void;
  rect: (x: number, y: number, width: number, height: number, style: string) => void;
  setTextColor: (red: number, green: number, blue: number) => void;
  setFontSize: (size: number) => void;
  text: (text: string, x: number, y: number) => void;
  setFont: (family: string, style: string) => void;
  addPage: () => void;
  save: (filename: string) => void;
};

export async function writeFunnelExportXlsx(rows: ReturnType<typeof buildFunnelExportRows>, filename: string, exceljs: ExcelJsWriter, saveFile: (data: ArrayBuffer, fileName: string) => void = browserDownload) {
  const workbook = new exceljs.Workbook();
  const worksheet = workbook.addWorksheet("Propostas");
  worksheet.columns = [
    { header: "Etapa", key: "Etapa", width: 20 }, { header: "Proposta", key: "Proposta", width: 34 }, { header: "Associado", key: "Associado", width: 28 }, { header: "Vendedor", key: "Vendedor", width: 24 }, { header: "Valor", key: "Valor", width: 16 }, { header: "Probabilidade", key: "Probabilidade", width: 16 }, { header: "Criada em", key: "Criada_em", width: 16 },
  ];
  worksheet.addRows(rows);
  worksheet.getRow(1).font = { bold: true };
  saveFile(await workbook.xlsx.writeBuffer(), filename);
}

export function browserDownload(data: ArrayBuffer, filename: string) {
  const url = URL.createObjectURL(new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

export function writeFunnelExportPdf(rows: ReturnType<typeof buildFunnelExportRows>, stage: FunnelExportStage, startDate: string, endDate: string, filename: string, doc: FunnelPdfDocument) {
  const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" });
  doc.setFillColor(29, 43, 42);
  doc.rect(0, 0, 297, 26, "F");
  doc.setTextColor(232, 208, 146);
  doc.setFontSize(18);
  doc.text("TSE Exclusive · Propostas do funil", 15, 16);
  doc.setTextColor(29, 43, 42);
  doc.setFontSize(10);
  doc.text(`${funnelExportStageLabels[stage]} · ${dateLabel(startDate)} a ${dateLabel(endDate)}`, 15, 38);
  rows.forEach((row, index) => {
    const y = 50 + index * 12;
    if (y > 195) doc.addPage();
    const lineY = y > 195 ? 20 + (index % 12) * 12 : y;
    doc.setFont("helvetica", "bold");
    doc.text(row.Proposta, 15, lineY);
    doc.setFont("helvetica", "normal");
    doc.text(`${row.Associado} · ${row.Vendedor} · ${money(row.Valor)} · ${row.Probabilidade}`, 15, lineY + 5);
  });
  doc.save(filename);
}
