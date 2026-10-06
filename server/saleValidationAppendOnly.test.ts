import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Revisão KAN-31 (item 8): sem triggers na migration 0044, a trilha sale_validation_events é append-only por CÓDIGO.
// Nenhum arquivo de produção pode atualizar ou apagar linhas dela (Drizzle ou SQL cru).
function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe("sale_validation_events é append-only por código", () => {
  const files = [...walk(join(__dirname)), ...walk(join(__dirname, "..", "shared")), ...walk(join(__dirname, "..", "scripts"))];
  const offenders = (pattern: RegExp) => files.filter(file => pattern.test(readFileSync(file, "utf8"))).map(file => file.replace(join(__dirname, ".."), ""));

  it("nenhum update/delete Drizzle sobre saleValidationEvents", () => {
    expect(offenders(/\.(update|delete)\(\s*saleValidationEvents\b/)).toEqual([]);
  });
  it("nenhum UPDATE/DELETE/TRUNCATE em SQL cru sobre sale_validation_events", () => {
    expect(offenders(/(update|delete\s+from|truncate(\s+table)?|drop\s+table)\s+`?sale_validation_events\b/i)).toEqual([]);
  });
  it("o serviço só insere (insert é o único verbo usado)", () => {
    const source = readFileSync(join(__dirname, "saleValidationService.ts"), "utf8");
    expect(source).toMatch(/insert\(saleValidationEvents\)/);
    expect(source).not.toMatch(/(update|delete)\(saleValidationEvents\)/);
  });
  it("a migration 0044 não cria triggers", () => {
    const sql = readFileSync(join(__dirname, "..", "drizzle", "0044_sale_validation_v6.sql"), "utf8");
    expect(sql).not.toMatch(/CREATE\s+TRIGGER/i);
  });
});
