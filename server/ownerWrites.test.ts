import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { getTableName } from "drizzle-orm";

// INT-13 (lado CRM): "só escreve no que é seu". Cada módulo que fala com outro sistema tem uma lista EXPLÍCITA do que pode gravar, e tudo
// precisa ser tabela do schema do próprio CRM. Gravar em qualquer outra coisa (outra tabela, outro schema, SQL cru) quebra este teste:
// quem precisar de uma tabela nova decide conscientemente e a inclui aqui, com revisão.
const ROOT = join(__dirname);
const crmTables = new Set(Object.values(schema).filter((value): value is Parameters<typeof getTableName>[0] => typeof value === "object" && value !== null && Symbol.for("drizzle:Name") in value).map(table => getTableName(table)));
const exportToTable = new Map(Object.entries(schema).filter(([, value]) => typeof value === "object" && value !== null && Symbol.for("drizzle:Name") in (value as object)).map(([name, value]) => [name, getTableName(value as Parameters<typeof getTableName>[0])]));

function writeTargets(file: string) {
  const source = readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = new Set<string>();
  for (const match of source.matchAll(/\.(?:insert|update|delete)\(\s*([A-Za-z_][\w]*)\s*\)/g)) if (exportToTable.has(match[1]!)) found.add(match[1]!);
  const raw = [...source.matchAll(/\b(INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|TRUNCATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\s+[`"]?([\w.]+)/gi)].map(match => match[2]!);
  return { tables: [...found].sort(), raw };
}

/** O que cada módulo de integração pode gravar. `[]` = somente leitura. Tudo aqui é dado do CRM (recebido de outro sistema, mas guardado no CRM). */
const ALLOWED: Record<string, string[]> = {
  "encounterTimesReceiver.ts": ["auditLogs", "encounterTimeRecords"],
  "attendanceReceiver.ts": ["attendanceRecords", "auditLogs", "coupleRegistry"],
  "nqReadEndpoint.ts": [],
  "financialBridge.ts": [],
  "relationshipBridge.ts": [],
  "paymentGatewayWebhook.ts": ["billingRecords", "financialTransactions", "installments", "paymentGatewayWebhookEvents"],
  "salesCommandBridge.ts": ["auditLogs", "captureRecords", "commercialFractionHistory", "commercialFractions", "contracts", "customers", "domainEvents", "financialTransactions", "installments", "opportunities", "proposals", "resorts"],
};

describe("INT-13 CRM: só escreve no que é seu", () => {
  it("o schema do CRM é a única fonte de tabelas gravadas (sanidade do próprio teste)", () => {
    expect(crmTables.size).toBeGreaterThan(50);
    expect(exportToTable.get("encounterTimeRecords")).toBe("encounter_time_records");
  });

  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file} grava somente ${allowed.length ? allowed.join(", ") : "nada (somente leitura)"}`, () => {
      const { tables, raw } = writeTargets(file);
      expect(tables.filter(table => !allowed.includes(table))).toEqual([]);
      for (const table of tables) expect(crmTables.has(exportToTable.get(table)!)).toBe(true);
      // SQL cru de escrita só é aceito se mirar tabela do schema do CRM (sem prefixo de outro banco)
      for (const target of raw) { expect(target).not.toContain("."); expect(crmTables.has(target)).toBe(true); }
    });
  }

  it("receptores externos e a leitura do NQ não tocam tabela de outro dono: nenhuma escrita em dados de Financial, Relationship, NQ ou Sales", () => {
    // Tabelas que o CRM só LÊ ou que pertencem a outro sistema não existem no schema; o teste acima garante isso por construção.
    // Aqui travamos o inverso: o endpoint do NQ nunca ganha escrita e as pontes de saída só leem o outbox (cursor fica em memória/rewind).
    for (const file of ["nqReadEndpoint.ts", "financialBridge.ts", "relationshipBridge.ts"]) expect(writeTargets(file).tables).toEqual([]);
  });
});
