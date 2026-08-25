import { describe, expect, it } from "vitest";
import { MAX_CSV_IMPORT_ROWS, assertCsvImportRowBudget } from "./csvImportGuard";

describe("orçamento de importação CSV", () => {
  it("aceita cabeçalho e até o limite operacional de linhas", () => {
    expect(() => assertCsvImportRowBudget(["nome", ...Array(MAX_CSV_IMPORT_ROWS).fill("Lucas")].join("\n"))).not.toThrow();
  });

  it("rejeita lote acima do limite antes de processar", () => {
    expect(() => assertCsvImportRowBudget(["nome", ...Array(MAX_CSV_IMPORT_ROWS + 1).fill("Lucas")].join("\n"))).toThrow(/10\.000/);
  });
});

