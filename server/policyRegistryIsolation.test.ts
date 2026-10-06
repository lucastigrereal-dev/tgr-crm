import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// WP11 (PRD §13): "não implementar regras monetárias reais sem documento APPROVED". Garantia estrutural: só o router
// do registry (e a agregação de routers) tocam a tabela; nenhum motor de dinheiro lê o registry.
const ALLOWED = new Set(["routers/policyRegistry.ts", "routers.ts"]);

function serverFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : serverFiles(full, base);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path.relative(base, full).replace(/\\/g, "/")] : [];
  });
}

describe("policy registry isolation", () => {
  it("no engine or bridge reads policy_registry", () => {
    const offenders = serverFiles(__dirname).filter(file => !ALLOWED.has(file)).filter(file => {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      return /\bpolicyRegistry\b|policy_registry|shared\/policyRegistry/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
