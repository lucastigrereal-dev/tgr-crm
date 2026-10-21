import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Os 3 checks obrigatórios podem ser PULADOS só quando o detector de "PR só de docs" rodou com sucesso. Job pulado conta como verde na proteção de branch,
// então falha do detector (rate-limit, permissão, transitório) NUNCA pode virar verde: tem de rodar tudo.
const ci = readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");
const jobBlock = (id: string) => { const start = ci.indexOf(`\n  ${id}:\n`); const rest = ci.slice(start + 1); const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/); return next < 0 ? rest : rest.slice(0, next + 1); };

describe("ci.yml: detector de PR só de docs é fail-safe", () => {
  it.each([["quality", "Typecheck, tests, build e bundle budget"], ["mysql-integration", "Testes *.mysql.test.ts em MySQL descartável"], ["e2e", "E2E autenticado em MySQL descartável"]])("%s mantém o nome do check obrigatório e só pula com detector OK + docs_only", (id, name) => {
    const block = jobBlock(id);
    expect(block).toContain(`name: ${name}`);
    expect(block).toContain("needs: changes");
    const condition = block.split("\n").find(line => line.trim().startsWith("if:"))!;
    expect(condition).toContain("!cancelled()");
    expect(condition).toContain("needs.changes.result != 'success'");
    expect(condition).toContain("needs.changes.outputs.docs_only != 'true'");
    // sem o ramo `result != 'success'` ou sem !cancelled(), falha do detector pularia o job (verde).
    expect(condition.indexOf("needs.changes.result != 'success'")).toBeLessThan(condition.indexOf("needs.changes.outputs.docs_only != 'true'"));
  });
  it("o detector só diz docs_only=true para PR e com lista de arquivos não vazia, e não engole falha do gh api", () => {
    const block = jobBlock("changes");
    expect(block).toContain('[ -n "$files" ]');
    expect(block).toContain("previous_filename"); // rename de server/x.ts para docs/x.ts nao pode virar docs_only
    expect(block).not.toMatch(/continue-on-error:\s*true/);
    expect(block).not.toContain("|| true");
    expect(ci).not.toMatch(/pull_request:[\s\S]{0,400}paths-ignore[\s\S]{0,60}\n\s*workflow_dispatch/);
  });
  it("tabela de decisão (a) detector ok+docs, (b) detector ok+código, (c) detector falhou", () => {
    // Mesma lógica do `if:` dos jobs pesados (draft fora): roda = !cancelled && (result != success || docs_only != true).
    const runs = (result: string, docsOnly: string) => result !== "success" || docsOnly !== "true";
    expect(runs("success", "true")).toBe(false);   // (a) pula => skipped = verde, correto: PR só de docs
    expect(runs("success", "false")).toBe(true);   // (b) código roda tudo
    expect(runs("failure", "")).toBe(true);        // (c) detector falhou => roda tudo
    expect(runs("cancelled", "")).toBe(true);      // detector cancelado: !cancelled() do run decide; aqui so a parte do detector
    expect(runs("skipped", "")).toBe(true);
  });
});
