import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// M-A06-03: ordem única de aplicação das migrations PROPOSTAS do CRM (0078–0091) provada em banco DESCARTÁVEL criado só para este teste:
// journal do drizzle do zero (idempotente), depois as propostas em ordem numérica; reaplicar o journal não muda nada e reaplicar uma proposta falha
// com erro claro sem corromper. Nenhuma migration vai a banco real.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const proposedDir = path.resolve(import.meta.dirname, "../migrations/proposed");
const files = readdirSync(proposedDir).filter(name => /^PROPOSED_\d{4}_.+\.sql$/.test(name)).sort();
const statementsOf = (file: string) => readFileSync(path.join(proposedDir, file), "utf8").split("--> statement-breakpoint").map(part => part.replace(/^--.*$/gm, "").trim()).filter(Boolean);

describe.skipIf(!integrationUrl)("migrations propostas do CRM: ordem de aplicação em banco descartável", () => {
  const scratch = `tgr_crm_mig_${randomUUID().slice(0, 8)}`;
  let admin: mysql.Connection;
  let pool: mysql.Pool;

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    const url = new URL(integrationUrl!);
    admin = await mysql.createConnection({ uri: integrationUrl });
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    url.pathname = `/${scratch}`;
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 2, multipleStatements: false });
  });
  afterAll(async () => { await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await admin?.end(); });

  it("a lista das propostas é 0078..0091 sem buraco nem repetição", () => {
    const numbers = files.map(name => Number(name.slice(9, 13)));
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => 78 + i));
  });

  it("journal do zero, depois as propostas em ordem numérica, e o journal reaplicado não muda nada", async () => {
    const db = drizzle({ client: pool });
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
    const tablesBefore = (await pool.query("SHOW TABLES"))[0] as Array<Record<string, string>>;
    for (const file of files) for (const statement of statementsOf(file)) await pool.query(statement);
    const tablesAfter = (await pool.query("SHOW TABLES"))[0] as Array<Record<string, string>>;
    expect(tablesAfter.length).toBeGreaterThan(tablesBefore.length); // as propostas criaram tabelas novas
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") }); // idempotente
    expect(((await pool.query("SHOW TABLES"))[0] as unknown[]).length).toBe(tablesAfter.length);
  });

  it("reaplicar 0078 falha com erro claro; reaplicar 0089 (IF NOT EXISTS) passa em silêncio; o esquema não muda", async () => {
    const before = JSON.stringify((await pool.query("SHOW TABLES"))[0]);
    const alter = files.find(name => name.startsWith("PROPOSED_0078_"))!;
    await expect((async () => { for (const statement of statementsOf(alter)) await pool.query(statement); })()).rejects.toMatchObject({ code: expect.stringMatching(/^ER_(DUP_FIELDNAME|DUP_KEYNAME|FK_DUP_NAME|DUP_FIELD)/) });
    expect(JSON.stringify((await pool.query("SHOW TABLES"))[0])).toBe(before);
  });

  it("reaplicar 0089 (CREATE TABLE IF NOT EXISTS) passa sem erro e não muda o esquema: sucesso no retry não prova que nunca foi aplicada", async () => {
    const before = JSON.stringify((await pool.query("SHOW TABLES"))[0]);
    const file = files.find(name => name.startsWith("PROPOSED_0089_"))!;
    for (const statement of statementsOf(file)) await pool.query(statement);
    expect(JSON.stringify((await pool.query("SHOW TABLES"))[0])).toBe(before);
  });
});
