#!/usr/bin/env node
// Runbook executável das migrations PROPOSTAS do CRM (0078–0091): status, apply e rollback, UMA por vez, com trava de backup verificado e prova depois.
// Autorização do Lucas (26/10): banco real só com backup, volta pronta e GO do Opus. Nunca roda `drizzle-kit push`. Ver docs/runbooks/CRM_MIGRATIONS_PROPOSTAS_RUNBOOK.md.
//
// Uso (DATABASE_URL = banco do piloto, ex.: mysql://tgr_app:<senha>@127.0.0.1:44326/tgr_crm_pilot; só 127.0.0.1/localhost):
//   node scripts/proposed-migration.mjs status
//   node scripts/proposed-migration.mjs apply 0078 --backup-manifest <manifest-*.json> --go "<referência do GO do Opus>"
//   node scripts/proposed-migration.mjs rollback 0078 --backup-manifest <manifest-*.json> --go "<referência do GO do Opus>"
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql from "mysql2/promise";

const here = path.dirname(fileURLToPath(import.meta.url));
const proposedDir = path.resolve(here, "../migrations/proposed");
const BACKUP_MAX_AGE_MINUTES = 60;

export const listProposed = (dir = proposedDir) => readdirSync(dir).filter(name => /^PROPOSED_\d{4}_.+\.sql$/.test(name)).sort().map(file => ({ number: file.slice(9, 13), file, path: path.join(dir, file) }));

const statementsOf = sql => sql.split("--> statement-breakpoint").map(part => part.replace(/^--.*$/gm, "").trim()).filter(Boolean);

/** Objetos que a migration cria, lidos do próprio SQL (a prova de "aplicada" e a volta saem daqui, não de uma lista paralela). */
export function parseObjects(sql) {
  const statements = statementsOf(sql);
  const tables = [], columns = [], enums = [], constraints = [];
  for (const statement of statements) {
    for (const match of statement.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)`/g)) tables.push(match[1]);
    const alter = /^ALTER TABLE `(\w+)`/.exec(statement);
    if (!alter) continue;
    const table = alter[1];
    for (const match of statement.matchAll(/ADD COLUMN `(\w+)`/g)) columns.push({ table, column: match[1] });
    for (const match of statement.matchAll(/ADD CONSTRAINT `(\w+)` FOREIGN KEY/g)) constraints.push({ table, kind: "fk", name: match[1] });
    for (const match of statement.matchAll(/ADD INDEX `(\w+)`/g)) constraints.push({ table, kind: "index", name: match[1] });
    const modify = /MODIFY COLUMN `(\w+)` enum\(([^)]*)\)/.exec(statement);
    if (modify) {
      const values = [...modify[2].matchAll(/'([^']*)'/g)].map(item => item[1]);
      const rollback = /--\s*Rollback:.*?MODIFY COLUMN \w+ (enum\([^)]*\) NOT NULL);/s.exec(sql);
      enums.push({ table, column: modify[1], values, rollbackType: rollback?.[1] ?? null });
    }
  }
  return { statements, tables, columns, enums, constraints };
}

const quote = name => { if (!/^\w+$/.test(name)) throw new Error(`identificador inesperado: ${name}`); return `\`${name}\``; };

export async function objectState(conn, db, objects) {
  const present = [], missing = [];
  const [tableRows] = await conn.query("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [db]);
  const existing = new Set(tableRows.map(row => row.n));
  for (const table of objects.tables) (existing.has(table) ? present : missing).push(`tabela ${table}`);
  for (const { table, column } of objects.columns) {
    const [rows] = await conn.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?", [db, table, column]);
    (rows.length ? present : missing).push(`coluna ${table}.${column}`);
  }
  for (const item of objects.enums) {
    const [rows] = await conn.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?", [db, item.table, item.column]);
    const type = rows[0]?.t ?? "";
    (item.values.every(value => type.includes(`'${value}'`)) ? present : missing).push(`enum ${item.table}.${item.column}`);
  }
  for (const item of objects.constraints) {
    const sql = item.kind === "fk"
      ? "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'"
      : "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?";
    const [rows] = await conn.query(sql, [db, item.table, item.name]);
    (rows.length ? present : missing).push(`${item.kind === "fk" ? "FK" : "índice"} ${item.name}`);
  }
  return { present, missing, applied: missing.length === 0 && present.length > 0, partial: present.length > 0 && missing.length > 0 };
}

export async function statusAll(conn, db) {
  const out = [];
  for (const item of listProposed()) {
    const objects = parseObjects(readFileSync(item.path, "utf8"));
    out.push({ number: item.number, file: item.file, ...(await objectState(conn, db, objects)) });
  }
  return out;
}

/** Contagem de linhas de toda tabela que já existia (antes e depois: tem que ser idêntica). */
async function rowCounts(conn, db, except = []) {
  const [tableRows] = await conn.query("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", [db]);
  const counts = {};
  for (const { n } of tableRows) { if (except.includes(n)) continue; const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM ${quote(n)}`); counts[n] = Number(rows[0].c); }
  return counts;
}

const sameCounts = (a, b) => Object.keys({ ...a, ...b }).filter(key => a[key] !== b[key]);

/** Trava do backup: manifest do backup-pilot (só existe se o restore drill passou), recente, com o .sql presente e com o hash conferido. */
export function verifyBackupManifest(manifestPath, now = new Date()) {
  if (!manifestPath || !existsSync(manifestPath)) throw new Error("Backup não informado ou inexistente: rode o backup-pilot (restore drill) e passe --backup-manifest <manifest-*.json>.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^﻿/, ""));
  const created = new Date(manifest.createdAt);
  if (Number.isNaN(created.getTime())) throw new Error("Manifest do backup sem createdAt válido.");
  const ageMinutes = (now.getTime() - created.getTime()) / 60000;
  if (ageMinutes > BACKUP_MAX_AGE_MINUTES || ageMinutes < -5) throw new Error(`Backup velho demais (${Math.round(ageMinutes)} min; limite ${BACKUP_MAX_AGE_MINUTES}). Faça outro antes de mexer no banco.`);
  if (!manifest.sqlFile || !existsSync(manifest.sqlFile)) throw new Error("Arquivo .sql do backup não encontrado no caminho do manifest.");
  const sha = createHash("sha256").update(readFileSync(manifest.sqlFile)).digest("hex").toUpperCase();
  if (sha !== String(manifest.sqlSha256).toUpperCase()) throw new Error("Hash do .sql do backup não confere com o manifest.");
  if (!(Number(manifest.verifiedTables) > 0)) throw new Error("Backup sem tabelas verificadas no restore drill.");
  const tables = Array.isArray(manifest.counts) ? manifest.counts.map(item => String(item.table)).sort() : [];
  if (!tables.length) throw new Error("Manifest do backup sem a lista de tabelas (counts).");
  return { createdAt: manifest.createdAt, sqlFile: manifest.sqlFile, verifiedTables: Number(manifest.verifiedTables), tables };
}

/** O backup tem que ser DESTE banco: o conjunto de tabelas do manifest (o backup-pilot sempre despeja o tgr_crm_pilot) tem que ser o mesmo do banco que vai ser alterado. */
export async function assertBackupMatchesDatabase(conn, db, backupInfo) {
  const [rows] = await conn.query("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", [db]);
  const live = rows.map(row => row.n).sort();
  const same = live.length === backupInfo.tables.length && live.every((name, i) => name === backupInfo.tables[i]);
  if (!same) {
    const missingInBackup = live.filter(name => !backupInfo.tables.includes(name));
    const extraInBackup = backupInfo.tables.filter(name => !live.includes(name));
    throw new Error(`O backup não é deste banco (${db}): ${missingInBackup.length} tabela(s) do banco fora do backup${missingInBackup.length ? ` (${missingInBackup.slice(0, 3).join(", ")})` : ""}, ${extraInBackup.length} do backup fora do banco${extraInBackup.length ? ` (${extraInBackup.slice(0, 3).join(", ")})` : ""}. Faça um backup NOVO logo antes (um por migration).`);
  }
}

export const PILOT_DATABASE = "tgr_crm_pilot";
export const PILOT_PORT = "44326";

/** `pilotOnly` (CLI): além de local, exige o banco e a porta do piloto, os únicos que o backup-pilot cobre. */
export function assertLocalDatabase(url, { pilotOnly = false } = {}) {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) throw new Error(`Host ${parsed.hostname} recusado: só o banco local do piloto (127.0.0.1) por este runbook.`);
  const db = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!db) throw new Error("DATABASE_URL sem nome de banco.");
  if (pilotOnly && (db !== PILOT_DATABASE || parsed.port !== PILOT_PORT)) throw new Error(`Alvo recusado (${db}:${parsed.port || "padrão"}): este runbook só altera ${PILOT_DATABASE} na porta ${PILOT_PORT}, o banco que o backup-pilot cobre.`);
  return db;
}

const log = (dir, entry) => { if (!dir) return; mkdirSync(dir, { recursive: true }); appendFileSync(path.join(dir, "migration-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); };

function pickMigration(number) {
  const item = listProposed().find(entry => entry.number === number);
  if (!item) throw new Error(`Migration ${number} não existe em migrations/proposed.`);
  return item;
}

export async function applyMigration(conn, db, number, { backup, go, logDir }) {
  if (!go || !String(go).trim()) throw new Error("Informe a referência do GO do Opus (--go).");
  const backupInfo = verifyBackupManifest(backup);
  await assertBackupMatchesDatabase(conn, db, backupInfo);
  const item = pickMigration(number);
  const objects = parseObjects(readFileSync(item.path, "utf8"));
  const states = await statusAll(conn, db);
  const mine = states.find(entry => entry.number === number);
  if (mine.partial) throw new Error(`Migration ${number} aplicada pela metade (${mine.present.join(", ")} existem; faltam ${mine.missing.join(", ")}). Parar e chamar o Opus; não reaplicar.`);
  if (mine.applied) throw new Error(`Migration ${number} já está aplicada. Nada a fazer.`);
  const earlier = states.filter(entry => entry.number < number && !entry.applied);
  if (earlier.length) throw new Error(`Ordem quebrada: faltam ${earlier.map(entry => entry.number).join(", ")} antes da ${number}.`);
  const before = await rowCounts(conn, db, objects.tables);
  log(logDir, { event: "apply_start", number, db, go, backup: { createdAt: backupInfo.createdAt, sqlFile: backupInfo.sqlFile, verifiedTables: backupInfo.verifiedTables } });
  let done = 0;
  try {
    for (const statement of objects.statements) { await conn.query(statement); done += 1; }
  } catch (error) {
    log(logDir, { event: "apply_failed", number, statementsDone: done, error: String(error.message).slice(0, 300) });
    const after = await statusAll(conn, db);
    const state = after.find(entry => entry.number === number);
    throw new Error(`Falha na ${number} (${done}/${objects.statements.length} instruções): ${error.message}. Estado agora: ${state.partial ? `PARCIAL (existem ${state.present.join(", ")})` : "nada aplicado"}. Rode "rollback ${number}" se ficou parcial (tabelas novas estão vazias) e chame o Opus.`);
  }
  const smoke = await smokeCheck(conn, db, number, objects, before);
  log(logDir, { event: "apply_ok", number, smoke });
  return smoke;
}

async function smokeCheck(conn, db, number, objects, before) {
  const state = await objectState(conn, db, objects);
  if (!state.applied) throw new Error(`Fumaça reprovada: faltam ${state.missing.join(", ")}.`);
  for (const table of objects.tables) {
    const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM ${quote(table)}`);
    if (Number(rows[0].c) !== 0) throw new Error(`Fumaça reprovada: tabela nova ${table} nasceu com linhas.`);
  }
  const after = await rowCounts(conn, db, objects.tables);
  const changed = sameCounts(before, after);
  if (changed.length) throw new Error(`Fumaça reprovada: contagem de linhas mudou em ${changed.join(", ")}.`);
  return { number, objects: state.present.length, newTablesEmpty: objects.tables.length, existingTablesUnchanged: Object.keys(before).length };
}

/** A volta: só desfaz o que a migration criou e só se esses objetos ainda estiverem sem dado (dado de casal/contrato nunca se apaga). */
export async function rollbackMigration(conn, db, number, { backup, go, logDir }) {
  if (!go || !String(go).trim()) throw new Error("Informe a referência do GO do Opus (--go).");
  const backupInfo = verifyBackupManifest(backup);
  await assertBackupMatchesDatabase(conn, db, backupInfo);
  const item = pickMigration(number);
  const objects = parseObjects(readFileSync(item.path, "utf8"));
  const states = await statusAll(conn, db);
  const later = states.filter(entry => entry.number > number && (entry.applied || entry.partial));
  if (later.length) throw new Error(`Desfaça primeiro as mais novas: ${later.map(entry => entry.number).join(", ")} (a volta é na ordem inversa).`);
  const mine = states.find(entry => entry.number === number);
  if (!mine.applied && !mine.partial) throw new Error(`Migration ${number} não está aplicada. Nada a desfazer.`);
  // Escritores (o app) ficam de fora do começo da checagem até o fim do DDL: LOCK TABLES WRITE nas tabelas que a volta toca. Sem isso uma linha poderia entrar entre o "está vazia" e o DROP.
  const touched = [...new Set([...objects.tables.filter(table => mine.present.includes(`tabela ${table}`)), ...objects.columns.map(item2 => item2.table), ...objects.enums.map(item2 => item2.table), ...objects.constraints.map(item2 => item2.table)])];
  await conn.query("SET SESSION lock_wait_timeout = 30");
  await conn.query(`LOCK TABLES ${touched.map(table => `${quote(table)} WRITE`).join(", ")}`);
  let result;
  try { result = await rollbackLocked(conn, db, number, { go, logDir, backupInfo, objects, mine }); }
  finally { await conn.query("UNLOCK TABLES"); }
  const after = (await statusAll(conn, db)).find(entry => entry.number === number);
  if (after.present.length) throw new Error(`Volta incompleta: restou ${after.present.join(", ")}.`);
  log(logDir, { event: "rollback_ok", number, steps: result.steps });
  return result;
}

async function rollbackLocked(conn, db, number, { go, logDir, backupInfo, objects, mine }) {
  const blockers = [];
  for (const table of objects.tables) {
    if (!mine.present.includes(`tabela ${table}`)) continue;
    const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM ${quote(table)}`);
    if (Number(rows[0].c) > 0) blockers.push(`${table} tem ${rows[0].c} linha(s)`);
  }
  for (const { table, column } of objects.columns) {
    if (!mine.present.includes(`coluna ${table}.${column}`)) continue;
    const [meta] = await conn.query("SELECT COLUMN_DEFAULT AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?", [db, table, column]);
    const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM ${quote(table)} WHERE NOT (${quote(column)} <=> ${meta[0].d === null ? "NULL" : conn.escape(meta[0].d)})`);
    if (Number(rows[0].c) > 0) blockers.push(`${table}.${column} tem ${rows[0].c} linha(s) fora do padrão`);
  }
  for (const item2 of objects.enums) {
    if (!item2.rollbackType) { blockers.push(`${item2.table}.${item2.column}: volta do enum não está descrita na migration`); continue; }
    const added = item2.values.filter(value => !item2.rollbackType.includes(`'${value}'`));
    for (const value of added) {
      const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM ${quote(item2.table)} WHERE ${quote(item2.column)} = ?`, [value]);
      if (Number(rows[0].c) > 0) blockers.push(`${item2.table}.${item2.column} tem ${rows[0].c} linha(s) com '${value}'`);
    }
  }
  if (blockers.length) { log(logDir, { event: "rollback_refused", number, blockers }); throw new Error(`Volta recusada (dado real não se apaga): ${blockers.join("; ")}. Chamar o Opus.`); }
  log(logDir, { event: "rollback_start", number, db, go, backup: { createdAt: backupInfo.createdAt, sqlFile: backupInfo.sqlFile, verifiedTables: backupInfo.verifiedTables } });
  const steps = [];
  for (const item2 of objects.enums) steps.push(`ALTER TABLE ${quote(item2.table)} MODIFY COLUMN ${quote(item2.column)} ${item2.rollbackType}`);
  // FK antes do índice: o MySQL não deixa soltar o índice de que a FK depende.
  for (const kind of ["fk", "index"]) for (const item3 of [...objects.constraints].reverse()) if (item3.kind === kind && mine.present.includes(`${kind === "fk" ? "FK" : "índice"} ${item3.name}`)) steps.push(kind === "fk" ? `ALTER TABLE ${quote(item3.table)} DROP FOREIGN KEY ${quote(item3.name)}` : `ALTER TABLE ${quote(item3.table)} DROP INDEX ${quote(item3.name)}`);
  for (const { table, column } of [...objects.columns].reverse()) if (mine.present.includes(`coluna ${table}.${column}`)) steps.push(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(column)}`);
  for (const table of [...objects.tables].reverse()) if (mine.present.includes(`tabela ${table}`)) steps.push(`DROP TABLE ${quote(table)}`);
  for (const step of steps) await conn.query(step);
  return { number, steps: steps.length };
}

async function main() {
  const [command, number, ...rest] = process.argv.slice(2);
  const flag = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Defina DATABASE_URL (banco do piloto em 127.0.0.1).");
  const db = assertLocalDatabase(url, { pilotOnly: process.env.PROPOSED_MIGRATION_ANY_DB !== "1" });
  const conn = await mysql.createConnection({ uri: url });
  const logDir = flag("--log-dir") ?? path.resolve("tgr-crm-migration-logs");
  try {
    if (command === "status") {
      for (const entry of await statusAll(conn, db)) console.log(`${entry.number} ${entry.applied ? "APLICADA" : entry.partial ? "PARCIAL" : "pendente"}  ${entry.file}`);
    } else if (command === "apply" || command === "rollback") {
      if (!/^\d{4}$/.test(number ?? "")) throw new Error("Informe o número da migration (ex.: 0078).");
      const fn = command === "apply" ? applyMigration : rollbackMigration;
      const result = await fn(conn, db, number, { backup: flag("--backup-manifest"), go: flag("--go"), logDir });
      console.log(`${command.toUpperCase()}=OK`, JSON.stringify(result));
    } else throw new Error("Comandos: status | apply NNNN | rollback NNNN (ver cabeçalho do arquivo).");
  } finally { await conn.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`ERRO: ${error.message}`); process.exit(1); });
