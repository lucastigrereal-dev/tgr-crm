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
    const csv = "numero_contrato;documento_associado;modelo_uso;status;valor_total;quantidade_parcelas;primeiro_vencimento\nTS-2026-001;12345678900;semana_flexivel;ativo;12.500,00;12;2026-09-10";
    const result = parseContractsCsv(csv);
    expect(result.issues).toEqual([]);
    expect(result.records).toMatchObject([{ number: "TS-2026-001", customerDocument: "12345678900", usageModel: "flexible_week", status: "active", totalAmount: 12500, installmentCount: 12, firstDueDate: "2026-09-10" }]);
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
