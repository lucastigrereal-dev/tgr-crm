import { describe, expect, it } from "vitest";
import { MAX_CSV_IMPORT_ROWS, MAX_CSV_LINE_LENGTH, assertCsvImportRowBudget, duplicateValueIndexes } from "./csvImportGuard";

describe("orçamento de importação CSV", () => {
  it("aceita cabeçalho e até o limite operacional de linhas", () => {
    expect(() => assertCsvImportRowBudget(["nome", ...Array(MAX_CSV_IMPORT_ROWS).fill("Lucas")].join("\n"))).not.toThrow();
  });

  it("rejeita lote acima do limite antes de processar", () => {
    expect(() => assertCsvImportRowBudget(["nome", ...Array(MAX_CSV_IMPORT_ROWS + 1).fill("Lucas")].join("\n"))).toThrow(/10\.000/);
  });

  it("rejeita uma linha individual acima do limite", () => {
    expect(() => assertCsvImportRowBudget(`nome\n${"x".repeat(MAX_CSV_LINE_LENGTH + 1)}`)).toThrow(/linha.*100\.000/);
  });

  it("encontra duplicidade ignorando caixa e espaços", () => {
    expect(duplicateValueIndexes([" CPF-1 ", "cpf-1", "CPF-2", "", null, "cpf-2"])).toEqual([1, 5]);
  });
});

