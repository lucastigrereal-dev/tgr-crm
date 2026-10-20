import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// INT-22: os rollbacks de docs/rollback (0061 a 0066) provados em MySQL descartável: sobe tudo, desce na ordem inversa, sobe de novo,
// desce de novo (sobe-desce-sobe-desce) e roda cada down em estado parcial (objetos já faltando) sem erro. O banco é criado só para este
// teste (sufixo _test, nome por execução) e apagado no fim; o banco compartilhado das outras suítes nem é tocado.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const root = path.resolve(import.meta.dirname, "..");
const BREAKPOINT = "--> statement-breakpoint";
const ROLLED = ["0061", "0062", "0063", "0064", "0065", "0066", "0067", "0068", "0069", "0070", "0071", "0072"];

type JournalEntry = { idx: number; tag: string; when: number };
const journal = (JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: JournalEntry[] }).entries;
const entryOf = (prefix: string) => journal.find(entry => entry.tag.startsWith(`${prefix}_`))!;
const chunks = (file: string) => readFileSync(path.join(root, file), "utf8").split(BREAKPOINT).map(part => part.trim()).filter(Boolean);

describe.skipIf(!integrationUrl)("rollbacks 0061 a 0072 em MySQL descartável (sobe-desce-sobe, estado parcial)", () => {
  let admin: mysql.Connection;
  let conn: mysql.Connection;
  const dbName = `tgr_crm_rb_${randomUUID().replace(/-/g, "").slice(0, 10)}_test`;

  const up = async (entry: JournalEntry) => {
    for (const statement of chunks(`drizzle/${entry.tag}.sql`)) await conn.query(statement);
    await conn.query("INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)", [`sintetico-${entry.tag}`, entry.when]);
  };
  const down = async (prefix: string) => {
    const entry = entryOf(prefix);
    for (const statement of chunks(`docs/rollback/${entry.tag}.down.sql`)) await conn.query(statement);
  };
  const tableExists = async (table: string) => ((await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [dbName, table]))[0] as Array<{ n: number }>)[0].n > 0;
  const columnExists = async (table: string, column: string) => ((await conn.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?", [dbName, table, column]))[0] as Array<{ n: number }>)[0].n > 0;
  const indexExists = async (table: string, index: string) => ((await conn.query("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?", [dbName, table, index]))[0] as Array<{ n: number }>)[0].n > 0;
  const enumHas = async (table: string, column: string, value: string) => ((await conn.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?", [dbName, table, column]))[0] as Array<{ t: string }>)[0]?.t.includes(`'${value}'`) ?? false;
  const appliedRolled = async () => ((await conn.query("SELECT COUNT(*) AS n FROM `__drizzle_migrations` WHERE created_at IN (?)", [ROLLED.map(prefix => entryOf(prefix).when)]))[0] as Array<{ n: number }>)[0].n;

  /** Objetos que as seis migrations criam; um por migration pelo menos, mais as colunas e o índice do caso parcial. */
  const probes = async () => ({
    prints: await tableExists("capture_sheet_prints"), members: await tableExists("capture_team_members"), roles: await tableExists("capture_team_roles"), settings: await tableExists("capture_sheet_settings"),
    motives: await tableExists("capture_motives"), times: await tableExists("encounter_time_records"), erasure: await tableExists("capture_erasure_requests"),
    coupleCode: await columnExists("capture_records", "coupleCode"), coupleIdx: await indexExists("capture_records", "captures_couple_code_unique"), maleSpouse: await columnExists("capture_records", "maleSpouse"),
    collectedAt: await columnExists("capture_sheet_prints", "collectedAt"), ntKind: await columnExists("capture_records", "ntKind"), captureAnon: await columnExists("capture_records", "anonymizedAt"), customerAnon: await columnExists("customers", "anonymizedAt"), promoterRole: await enumHas("sales_commissions", "commissionRole", "promoter"), issueIntents: await tableExists("payment_gateway_issue_intents"), ruleVersion: await columnExists("sales_commissions", "ruleVersion"), projectMap: await tableExists("financial_project_map"), addenda: await tableExists("contract_addenda"), grants: await tableExists("sale_validator_grants"),
  });
  const allPresent = { prints: true, members: true, roles: true, settings: true, motives: true, times: true, erasure: true, coupleCode: true, coupleIdx: true, maleSpouse: true, collectedAt: true, ntKind: true, captureAnon: true, customerAnon: true, promoterRole: true, issueIntents: true, ruleVersion: true, projectMap: true, addenda: true, grants: true };
  const allGone = Object.fromEntries(Object.entries(allPresent).map(([key]) => [key, false]));

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    const url = new URL(integrationUrl!);
    url.pathname = "/";
    admin = await mysql.createConnection({ uri: url.toString(), multipleStatements: true });
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    url.pathname = `/${dbName}`;
    conn = await mysql.createConnection({ uri: url.toString(), multipleStatements: true });
    await conn.query("CREATE TABLE `__drizzle_migrations` (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)");
    for (const entry of journal) await up(entry);
  }, 120_000);
  afterAll(async () => {
    await conn?.end();
    if (admin) {
      if (/^tgr_crm_rb_[a-z0-9]+_test$/.test(dbName)) await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await admin.end();
    }
  }, 30_000);

  it("estado inicial: as sete migrations aplicadas, todos os objetos presentes", async () => {
    expect(await probes()).toEqual(allPresent);
    expect(await appliedRolled()).toBe(ROLLED.length);
  });

  it("desce na ordem inversa (0072 a 0061), sobe de novo (0061 a 0072) e desce outra vez: cada passo deixa o banco no estado esperado", async () => {
    for (const prefix of [...ROLLED].reverse()) await down(prefix);
    expect(await probes()).toEqual(allGone);
    expect(await appliedRolled()).toBe(0);

    for (const prefix of ROLLED) await up(entryOf(prefix));
    expect(await probes()).toEqual(allPresent);
    expect(await appliedRolled()).toBe(ROLLED.length);
    // As sementes voltam com a migração (INSERT IGNORE) e o catálogo de motivos também.
    expect(((await conn.query("SELECT COUNT(*) AS n FROM `capture_sheet_settings` WHERE `key` IN ('room_visibility_days','paper_destroy_deadline_days','privacy_dpo_name')"))[0] as Array<{ n: number }>)[0].n).toBe(3);
    expect(((await conn.query("SELECT COUNT(*) AS n FROM `capture_motives`"))[0] as Array<{ n: number }>)[0].n).toBeGreaterThan(20);

    for (const prefix of [...ROLLED].reverse()) await down(prefix);
    expect(await probes()).toEqual(allGone);
    for (const prefix of ROLLED) await up(entryOf(prefix));
    expect(await probes()).toEqual(allPresent);
  }, 120_000);

  it("estado parcial: com objetos já faltando, cada down roda inteiro sem erro e pode ser repetido", async () => {
    // Estado parcial de verdade: uma tabela, uma coluna, um índice e uma chave estrangeira já sumiram antes do rollback.
    await conn.query("DROP TABLE `capture_team_members`");
    await conn.query("DROP TABLE `encounter_time_records`");
    await conn.query("ALTER TABLE `capture_records` DROP COLUMN `guest1Name`");
    await conn.query("ALTER TABLE `capture_records` DROP INDEX `captures_couple_code_unique`");
    await conn.query("ALTER TABLE `capture_sheet_prints` DROP FOREIGN KEY `capture_sheet_prints_collectedByUserId_users_id_fk`");
    await conn.query("ALTER TABLE `capture_records` DROP COLUMN `ntKind`");
    for (const prefix of [...ROLLED].reverse()) await down(prefix);
    expect(await probes()).toEqual(allGone);
    // Repetir sobre o banco já desfeito também não pode falhar (o DELETE do controle é no-op).
    for (const prefix of [...ROLLED].reverse()) await down(prefix);
    expect(await probes()).toEqual(allGone);
    expect(await appliedRolled()).toBe(0);
  }, 120_000);
});
