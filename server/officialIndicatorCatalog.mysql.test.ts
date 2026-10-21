import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { DEFAULT_INDICATOR_CATALOG, resolveIndicatorCatalog } from "./officialIndicatorCatalog";

const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe("item 8: catálogo único de motivos (proposta do tipo recovery)", () => {
  it("a PROPOSED_0082 só AMPLIA o enum de capture_motives (mantém os valores e a ordem) e o schema/rota seguem sem `recovery` até aplicar", () => {
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0082_capture_motives_recovery_kind.sql"), "utf8");
    expect(sql).toContain("enum('nt_perfil','nt_tempo','nt_consultor','nt_mesa','qualificacao','recovery')");
    const schema = readFileSync(path.resolve(__dirname, "../drizzle/schema.ts"), "utf8");
    expect(schema).toContain('mysqlEnum("kind", ["nt_perfil", "nt_tempo", "nt_consultor", "nt_mesa", "qualificacao"])');
    expect(readFileSync(path.resolve(__dirname, "routers/captureSheet.ts"), "utf8")).not.toMatch(/MOTIVE_KINDS = \[[^\]]*recovery/);
  });
});

describe("catálogo de indicadores oficiais (puro)", () => {
  it("sem linhas vale o padrão; a maior versão por código vence; código desconhecido é ignorado", () => {
    expect(resolveIndicatorCatalog([]).map(e => [e.code, e.isDefault, e.version])).toEqual([["utilization", true, 0], ["efficiency", true, 0]]);
    const out = resolveIndicatorCatalog([
      { code: "utilization", version: 1, label: "A", description: "", active: true },
      { code: "utilization", version: 2, label: "B", description: "d", active: false },
      { code: "inventado", version: 9, label: "X", description: "", active: true },
    ]);
    expect(out[0]).toMatchObject({ code: "utilization", version: 2, label: "B", active: false, isDefault: false });
    expect(out[1]).toMatchObject({ code: "efficiency", label: DEFAULT_INDICATOR_CATALOG.efficiency.label, isDefault: true });
  });
});

describe.skipIf(!integrationUrl)("catálogo de indicadores oficiais em MySQL real (0081 PROPOSTA inteira em banco descartável)", () => {
  let admin: mysql.Pool; let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let scratch = ""; let adminId = 0;
  const previousEnv = { ...process.env }; const previousFlag = ENV.officialIndicatorCatalogEnabled;
  const caller = async (role: "admin" | "finance" = "admin") => (await import("./routers/officialIndicators")).officialIndicatorsRouter.createCaller({ user: { id: adminId, role } } as never);

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratch = `${database.replace(/_test$/i, "")}_oi${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["users", "audit_logs", "domain_events"]) await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const url = new URL(integrationUrl!); url.pathname = `/${scratch}`;
    process.env.DATABASE_URL = url.toString();
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 6 }); db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0081_official_indicator_versions.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    [{ id: adminId }] = await db.insert(users).values({ openId: `oi-cat-${runId}`, name: "Admin SYN", role: "admin" }).$returningId();
    ENV.officialIndicatorCatalogEnabled = true;
  });
  afterAll(async () => { ENV.officialIndicatorCatalogEnabled = previousFlag; process.env = previousEnv; await pool?.end(); if (scratch) await admin?.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await admin?.end(); });

  it("versiona: cada save é uma versão nova (append-only), o histórico guarda quem e a lista vigente reflete a última", async () => {
    const api = await caller();
    expect((await api.catalog()).every(e => e.isDefault)).toBe(true);
    await api.saveCatalogEntry({ code: "utilization", label: "Aproveitamento CRM", description: "v1", active: true });
    await api.saveCatalogEntry({ code: "utilization", label: "Aproveitamento oficial", description: "v2", active: false });
    const current = (await api.catalog()).find(e => e.code === "utilization")!;
    expect(current).toMatchObject({ version: 2, label: "Aproveitamento oficial", active: false, isDefault: false });
    const history = await api.catalogHistory({ code: "utilization" });
    expect(history.map(h => [h.version, h.createdByUserId])).toEqual([[2, adminId], [1, adminId]]);
    expect((await db.select().from(auditLogs)).filter(a => a.action === "catalog_version_saved")).toHaveLength(2);
  });

  it("saves concorrentes do mesmo indicador não duplicam versão", async () => {
    const api = await caller();
    await Promise.all([1, 2, 3].map(i => api.saveCatalogEntry({ code: "efficiency", label: `Eficiência ${i}`, description: "", active: true })));
    expect((await api.catalogHistory({ code: "efficiency" })).map(h => h.version).sort()).toEqual([1, 2, 3]);
  });

  it("só admin escreve/lê o catálogo e a flag desligada recusa tudo", async () => {
    await expect((await caller("finance")).saveCatalogEntry({ code: "utilization", label: "xxx", description: "", active: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    ENV.officialIndicatorCatalogEnabled = false;
    try { await expect((await caller()).catalog()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); } finally { ENV.officialIndicatorCatalogEnabled = true; }
  });
});
