import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
// @ts-expect-error script .mjs sem tipos
import { applyMigration, assertLocalDatabase, listProposed, parseObjects, rollbackMigration, statusAll, verifyBackupManifest } from "../scripts/proposed-migration.mjs";

// Runbook das migrations propostas (0078–0091): o script aplica UMA por vez, só com backup verificado, prova depois e sabe voltar. Banco DESCARTÁVEL criado só para este teste.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;

describe.skipIf(!integrationUrl)("scripts/proposed-migration.mjs (MySQL real, banco descartável)", () => {
  const scratch = `tgr_crm_runbook_${randomUUID().slice(0, 8)}`;
  let admin: mysql.Connection;
  let conn: mysql.Connection;
  let pool: mysql.Pool;
  const dir = mkdtempSync(path.join(tmpdir(), "runbook-"));
  const sqlFile = path.join(dir, "dump.sql");
  writeFileSync(sqlFile, "-- dump sintético");
  const manifestFor = (overrides: Record<string, unknown> = {}) => {
    const file = path.join(dir, `manifest-${randomUUID().slice(0, 6)}.json`);
    writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), sqlFile, sqlSha256: createHash("sha256").update(readFileSync(sqlFile)).digest("hex").toUpperCase(), verifiedTables: 120, ...overrides }));
    return file;
  };
  const opts = (extra: Record<string, unknown> = {}) => ({ backup: manifestFor(), go: "GO-OPUS-SINTETICO", logDir: dir, ...extra });
  const numbers = listProposed().map((item: { number: string }) => item.number);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    admin = await mysql.createConnection({ uri: integrationUrl });
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const url = new URL(integrationUrl!); url.pathname = `/${scratch}`;
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 2 });
    await migrate(drizzle({ client: pool }), { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
    conn = await mysql.createConnection({ uri: url.toString() });
  }, 120_000);
  afterAll(async () => { await conn?.end(); await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await admin?.end(); });

  it("lê os objetos de cada migration do próprio SQL (nenhuma fica sem objeto verificável)", () => {
    for (const item of listProposed()) { const o = parseObjects(readFileSync(item.path, "utf8")); expect(o.tables.length + o.columns.length + o.enums.length, item.file).toBeGreaterThan(0); }
    expect(numbers[0]).toBe("0078");
    expect(numbers.at(-1)).toBe("0091");
    expect(parseObjects(readFileSync(listProposed().find((i: { number: string }) => i.number === "0078")!.path, "utf8")).constraints.map((c: { name: string }) => c.name).sort()).toEqual(["reneg_new_installment_fk", "renegotiations_new_installment_idx"]);
    expect(parseObjects(readFileSync(listProposed().find((i: { number: string }) => i.number === "0082")!.path, "utf8")).enums[0].rollbackType).toContain("'qualificacao')");
  });

  it("trava de backup: sem manifest, velho, hash trocado ou sem tabelas verificadas = recusa e nada muda", async () => {
    expect(() => verifyBackupManifest(undefined)).toThrow(/Backup não informado/);
    expect(() => verifyBackupManifest(manifestFor({ createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }))).toThrow(/velho demais/);
    expect(() => verifyBackupManifest(manifestFor({ sqlSha256: "00".repeat(32) }))).toThrow(/Hash/);
    expect(() => verifyBackupManifest(manifestFor({ verifiedTables: 0 }))).toThrow(/tabelas verificadas/);
    expect(() => verifyBackupManifest(manifestFor({ sqlFile: path.join(dir, "nao-existe.sql") }))).toThrow(/não encontrado/);
    await expect(applyMigration(conn, scratch, "0078", { backup: undefined, go: "GO", logDir: dir })).rejects.toThrow(/Backup/);
    await expect(applyMigration(conn, scratch, "0078", { backup: manifestFor(), go: "", logDir: dir })).rejects.toThrow(/GO do Opus/);
    expect((await statusAll(conn, scratch)).every((entry: { applied: boolean }) => !entry.applied)).toBe(true);
  });

  it("só aceita o banco local do piloto", () => {
    expect(assertLocalDatabase("mysql://u:p@127.0.0.1:44326/tgr_crm_pilot")).toBe("tgr_crm_pilot");
    expect(() => assertLocalDatabase("mysql://u:p@db.exemplo.com:3306/x")).toThrow(/recusado/);
  });

  it("ordem: pular a 0078 é recusado", async () => {
    await expect(applyMigration(conn, scratch, "0079", opts())).rejects.toThrow(/Ordem quebrada: faltam 0078/);
  });

  it("aplica 0078→0091 uma por vez, com fumaça (tabelas novas vazias, tabelas antigas intactas); reaplicar é recusado", async () => {
    for (const number of numbers) {
      const smoke = await applyMigration(conn, scratch, number, opts());
      expect(smoke.number).toBe(number);
      await expect(applyMigration(conn, scratch, number, opts())).rejects.toThrow(/já está aplicada/);
    }
    expect((await statusAll(conn, scratch)).every((entry: { applied: boolean }) => entry.applied)).toBe(true);
  });

  it("volta na ordem inversa: a mais velha não sai antes da mais nova; volta e reaplica a 0091 e a 0082 (enum) sem sobra", async () => {
    await expect(rollbackMigration(conn, scratch, "0090", opts())).rejects.toThrow(/Desfaça primeiro as mais novas: 0091/);
    for (const number of ["0091", "0090", "0089", "0088", "0087", "0086", "0085", "0084", "0083", "0082"]) await rollbackMigration(conn, scratch, number, opts());
    const [rows] = await conn.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'capture_motives' AND COLUMN_NAME = 'kind'", [scratch]) as any;
    expect(rows[0].t).not.toContain("recovery");
    for (const number of ["0082", "0083", "0084", "0085", "0086", "0087", "0088", "0089", "0090", "0091"]) await applyMigration(conn, scratch, number, opts());
    expect((await statusAll(conn, scratch)).every((entry: { applied: boolean }) => entry.applied)).toBe(true);
  });

  it("volta da 0078 (coluna + FK + índice) e reaplicação", async () => {
    for (const number of [...numbers].reverse().filter(n => n !== "0078" && n >= "0079")) await rollbackMigration(conn, scratch, number, opts());
    await rollbackMigration(conn, scratch, "0078", opts());
    const [cols] = await conn.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'installment_renegotiations' AND COLUMN_NAME = 'newInstallmentId'", [scratch]) as any;
    expect(cols).toHaveLength(0);
    for (const number of numbers) await applyMigration(conn, scratch, number, opts());
  });

  it("dado real não se apaga: tabela nova com linha, ou enum 'recovery' em uso, recusa a volta", async () => {
    const [user] = await conn.query("INSERT INTO users (openId, name, role) VALUES (?, 'SYN', 'admin')", [`rb-${randomUUID().slice(0, 6)}`]) as any;
    await conn.query("INSERT INTO capture_motives (kind, code, label) VALUES ('recovery', 'syn', 'SYN motivo')");
    await conn.query("INSERT INTO feature_flag_overrides (flagKey, enabled, createdByUserId) VALUES ('SYN', 0, ?)", [user.insertId]);
    await expect(rollbackMigration(conn, scratch, "0084", opts())).rejects.toThrow(/Desfaça primeiro as mais novas/);
    for (const number of ["0091", "0090", "0089", "0088", "0087", "0086", "0085"]) await rollbackMigration(conn, scratch, number, opts());
    await expect(rollbackMigration(conn, scratch, "0084", opts())).rejects.toThrow(/Volta recusada.*feature_flag_overrides tem 1 linha/);
    await conn.query("DELETE FROM feature_flag_overrides");
    await rollbackMigration(conn, scratch, "0084", opts());
    await rollbackMigration(conn, scratch, "0083", opts());
    await expect(rollbackMigration(conn, scratch, "0082", opts())).rejects.toThrow(/Volta recusada.*'recovery'/);
    await conn.query("DELETE FROM capture_motives WHERE kind = 'recovery'");
    await rollbackMigration(conn, scratch, "0082", opts());
  });
});
