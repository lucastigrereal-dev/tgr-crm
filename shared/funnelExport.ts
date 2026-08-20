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

type XlsxWriter = {
  utils: {
    json_to_sheet: (rows: ReturnType<typeof buildFunnelExportRows>) => any;
    book_new: () => any;
    book_append_sheet: (workbook: any, worksheet: any, name: string) => void;
  };
  writeFile: (workbook: any, filename: string) => void;
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

export function writeFunnelExportXlsx(rows: ReturnType<typeof buildFunnelExportRows>, filename: string, xlsx: XlsxWriter) {
  const worksheet = xlsx.utils.json_to_sheet(rows) as Record<string, unknown>;
  worksheet["!cols"] = [{ wch: 20 }, { wch: 34 }, { wch: 28 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Propostas");
  xlsx.writeFile(workbook, filename);
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
