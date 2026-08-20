import { describe, expect, it } from "vitest";
import { buildFunnelExportFilename, buildFunnelExportRows, writeFunnelExportPdf, writeFunnelExportXlsx } from "../shared/funnelExport";

describe("exportação filtrada de propostas", () => {
  it("preserva o estágio aplicado e os dados da proposta na linha exportada", () => {
    const rows = buildFunnelExportRows("negotiation", [{
      opportunity: { title: "Cota família", expectedAmount: "12500.50", probability: 70, createdAt: "2026-08-10T12:00:00.000Z" },
      customerName: "Ana da Silva",
      sellerName: "Vendedor Tigre",
    }]);

    expect(rows).toEqual([{
      Etapa: "Negociação",
      Proposta: "Cota família",
      Associado: "Ana da Silva",
      Vendedor: "Vendedor Tigre",
      Valor: 12500.5,
      Probabilidade: "70%",
      Criada_em: "10/08/2026",
    }]);
  });

  it("identifica o arquivo pelo estágio, período e formato efetivamente filtrados", () => {
    expect(buildFunnelExportFilename("proposal", "2026-08-01", "2026-08-31", "xlsx"))
      .toBe("tse-propostas-proposal-2026-08-01-2026-08-31.xlsx");
    expect(buildFunnelExportFilename("won", "2026-08-01", "2026-08-31", "pdf"))
      .toBe("tse-propostas-won-2026-08-01-2026-08-31.pdf");
  });

  it("entrega as linhas filtradas ao escritor XLSX seguro e grava com o nome esperado", async () => {
    const rows = buildFunnelExportRows("proposal", [{ opportunity: { title: "Cota teste", expectedAmount: 8000, probability: 55, createdAt: "2026-08-12T12:00:00.000Z" }, customerName: "Bruno Costa", sellerName: null }]);
    const worksheet = { columns: [], addRows: (received: typeof rows) => expect(received).toEqual(rows), getRow: () => ({ font: {} }) };
    const exceljs = { Workbook: class { addWorksheet(name: string) { expect(name).toBe("Propostas"); return worksheet; } xlsx = { writeBuffer: async () => new ArrayBuffer(8) }; } };
    const downloads: string[] = [];

    await writeFunnelExportXlsx(rows, buildFunnelExportFilename("proposal", "2026-08-01", "2026-08-31", "xlsx"), exceljs, (_, filename) => downloads.push(filename));
    expect(worksheet.columns).toHaveLength(7);
    expect(downloads).toEqual(["tse-propostas-proposal-2026-08-01-2026-08-31.xlsx"]);
  });

  it("escreve o cabeçalho e salva o PDF filtrado com o nome esperado", () => {
    const rows = buildFunnelExportRows("won", [{ opportunity: { title: "Cota vendida", expectedAmount: 15000, probability: 100, createdAt: "2026-08-18T12:00:00.000Z" }, customerName: "Carla Melo", sellerName: "Time Ouro" }]);
    const calls: string[] = [];
    const doc = { setFillColor: () => calls.push("fill"), rect: () => calls.push("rect"), setTextColor: () => calls.push("textColor"), setFontSize: () => calls.push("fontSize"), text: (text: string) => calls.push(`text:${text}`), setFont: () => calls.push("font"), addPage: () => calls.push("page"), save: (filename: string) => calls.push(`save:${filename}`) };

    writeFunnelExportPdf(rows, "won", "2026-08-01", "2026-08-31", buildFunnelExportFilename("won", "2026-08-01", "2026-08-31", "pdf"), doc);
    expect(calls).toEqual(expect.arrayContaining(["text:TSE Exclusive · Propostas do funil", "text:Ganhos · 01/08/2026 a 31/08/2026", "text:Cota vendida", "save:tse-propostas-won-2026-08-01-2026-08-31.pdf"]));
  });
});
