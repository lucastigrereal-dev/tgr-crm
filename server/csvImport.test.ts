import { describe, expect, it } from "vitest";
import { parseContractsCsv, parseCustomersCsv } from "./csvImport";

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
});
