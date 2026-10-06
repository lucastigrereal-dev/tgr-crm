import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// WP11 (PRD §13): "não implementar regras monetárias reais sem documento APPROVED". Garantia estrutural: só o router
// do registry (e a agregação de routers) tocam a tabela; nenhum motor de dinheiro lê o registry.
const ALLOWED = new Set(["routers/policyRegistry.ts", "routers.ts"]);
const MENTIONS = /\bpolicyRegistry\b|policy_registry|shared\/policyRegistry/i;

function sourceFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sourceFiles(full, base);
    return /\.(tsx?|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path.relative(base, full).replace(/\\/g, "/")] : [];
  });
}
const scan = (dir: string, allowed: Set<string>) => sourceFiles(dir).filter(file => !allowed.has(file))
  .filter(file => MENTIONS.test(readFileSync(path.join(dir, file), "utf8")));

describe("policy registry isolation", () => {
  it("no engine or bridge in server/ reads policy_registry (any case)", () => {
    expect(scan(__dirname, ALLOWED)).toEqual([]);
  });

  it("shared/ only holds the registry rules themselves (no engine there uses them)", () => {
    expect(scan(path.join(__dirname, "../shared"), new Set(["policyRegistry.ts"]))).toEqual([]);
  });
});
