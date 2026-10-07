import { describe, expect, it } from "vitest";
import { applyCsvMapping, buildImportErrorReport, parseContractsCsv, parseCustomersCsv, parseUnitsCsv, suggestCsvMapping } from "./csvImport";

describe("importação CSV", () => {
  it("lê associados com cabeçalho em português e separador ponto e vírgula", () => {
    const csv = "nome_completo;documento;email;status;cidade;uf\nAna da Silva;123.456.789-00;ana@exemplo.com;ativo;Olímpia;SP";
    const result = parseCustomersCsv(csv);
    expect(result.issues).toEqual([]);
    expect(result.records).toMatchObject([{ fullName: "Ana da Silva", documentNumber: "12345678900", status: "active", city: "Olímpia", state: "SP" }]);
  });

  it("valida documento duplicado e e-mail inválido antes de qualquer gravação", () => {
    const csv = "nome_completo,documento,email\nAna da Silva,12345678900,erro\nBia Souza,12345678900,bia@exemplo.com";
    const result = parseCustomersCsv(csv);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 2, field: "email" }),
      expect.objectContaining({ line: 3, field: "documento" }),
    ]));
  });

  it("lê contrato, converte moeda brasileira e normaliza modelo de uso", () => {
    const csv = "numero_contrato;documento_associado;modelo_uso;status;valor_total;quantidade_parcelas;primeiro_vencimento\nTS-2026-001;12345678900;semana_flexivel;pendente_assinatura;12.500,00;12;2026-09-10";
    const result = parseContractsCsv(csv);
    expect(result.issues).toEqual([]);
    expect(result.records).toMatchObject([{ number: "TS-2026-001", customerDocument: "12345678900", usageModel: "flexible_week", status: "pending_signature", totalAmount: 12500, installmentCount: 12, firstDueDate: "2026-09-10" }]);
  });

  it("RED TEAM: contrato ativo/inadimplente/encerrado exige decisão LEGACY_ACTIVE_BACKFILL (erro por linha)", () => {
    const header = "numero_contrato;documento_associado;modelo_uso;status;valor_total;quantidade_parcelas;primeiro_vencimento";
    for (const [status, line] of [["ativo", 2], ["active", 3], ["inadimplente", 4], ["overdue", 5], ["encerrado", 6], ["closed", 7]] as const) {
      const csv = `${header}\n` + Array.from({ length: line - 2 }, (_, i) => `OK-${status}-${i};12345678900;pontos;rascunho;1000;2;2026-09-10`).join("\n") + (line > 2 ? "\n" : "") + `TS-${status};12345678900;pontos;${status};1000;2;2026-09-10`;
      const result = parseContractsCsv(csv);
      expect(result.issues, status).toEqual([expect.objectContaining({ line, field: "status", message: expect.stringContaining("LEGACY_ACTIVE_BACKFILL") })]);
    }
  });

  it("rascunho, pendente_assinatura e cancelado continuam importáveis", () => {
    const csv = ["numero_contrato;documento_associado;modelo_uso;status;valor_total;quantidade_parcelas;primeiro_vencimento", "A-1;12345678900;pontos;rascunho;1000;2;2026-09-10", "A-2;12345678900;pontos;pending_signature;1000;2;2026-09-10", "A-3;12345678900;pontos;cancelado;1000;2;2026-09-10"].join("\n");
    const result = parseContractsCsv(csv);
    expect(result.issues).toEqual([]);
    expect(result.records.map(record => record.status)).toEqual(["draft", "pending_signature", "cancelled"]);
  });

  it("lê empreendimento e unidade com capacidade, camas e status", () => {
    const source = "empreendimento;cidade;uf;unidade;categoria;capacidade;camas;status_unidade\nResort Águas Quentes;Olímpia;SP;A-120;Premium;6;3;manutencao";
    const normalized = applyCsvMapping(source, suggestCsvMapping(source, "units").suggestedMapping);
    const result = parseUnitsCsv(normalized);
    expect(result.issues).toEqual([]);
    expect(result.records).toMatchObject([{ resortName: "Resort Águas Quentes", resortCity: "Olímpia", resortState: "SP", code: "A-120", category: "Premium", capacity: 6, beds: 3, status: "maintenance" }]);
  });

  it("sugere mapeamento de cabeçalhos comuns e aplica o formato canônico", () => {
    const source = "Nome do Cliente;CPF;E-mail;Celular\nAna da Silva;12345678900;ana@exemplo.com;17999999999";
    const suggestion = suggestCsvMapping(source, "customers");
    expect(suggestion.suggestedMapping).toMatchObject({ nome_completo: "Nome do Cliente", documento: "CPF", email: "E-mail", telefone: "Celular" });
    const normalized = applyCsvMapping(source, suggestion.suggestedMapping);
    expect(parseCustomersCsv(normalized).issues).toEqual([]);
  });

  it("gera relatório CSV de erros por linha para correção", () => {
    const report = buildImportErrorReport([{ line: 2, field: "documento", message: "Informe o documento do associado." }]);
    expect(report).toContain("linha;campo;mensagem");
    expect(report).toContain("2;documento;Informe o documento do associado.");
  });

  it("protege relatório de erros quando a mensagem contém ponto e vírgula", () => {
    const report = buildImportErrorReport([{ line: 7, field: "email", message: "E-mail inválido; revise o campo." }]);
    expect(report).toContain('7;email;"E-mail inválido; revise o campo."');
  });
});
