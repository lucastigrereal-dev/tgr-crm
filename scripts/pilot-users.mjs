#!/usr/bin/env node
// P-06 (piloto na sala): gera os usuários de login local do CRM (LOCAL_AUTH_USERS) com senha temporária.
// Idempotente: quem já está em <out>/crm-users.json mantém a senha; só os novos ganham senha. `--rotate nome` troca a de um.
// Senhas em texto ficam SÓ em <out>/crm-credentials.local.txt (modo 600, fora do Git); o stdout não mostra senha nem hash.
// --env-name troca o nome da variável no .env gerado (o compose portátil da Suite usa CRM_LOCAL_AUTH_USERS).
// Uso: node scripts/pilot-users.mjs [--perfil-sala] --out <pasta-fora-do-repo> --user ana.adm:admin:"Ana Administrativo" --user bia.fin:finance
import { randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROLES = ["admin", "seller", "finance", "service"];
const USERNAME = /^[a-z0-9._-]{3,58}$/;
const args = process.argv.slice(2);
const flags = { out: "", user: [], rotate: [], sala: false, envName: "LOCAL_AUTH_USERS" };
for (let i = 0; i < args.length; i += 1) {
  const key = args[i];
  if (key === "--out") flags.out = args[++i] ?? "";
  else if (key === "--user") flags.user.push(args[++i] ?? "");
  else if (key === "--env-name") flags.envName = args[++i] ?? "";
  else if (key === "--perfil-sala") flags.sala = true;
  else if (key === "--rotate") flags.rotate.push(args[++i] ?? "");
  else fail(`Argumento desconhecido: ${key}`);
}
function fail(message) { console.error(message); process.exit(1); }
if (!flags.out) fail("Informe --out <pasta> (fora do repositório).");
// Perfis do CRM no piloto (PLANO_PILOTO_3_DIAS §1.2): só 3 perfis entram no CRM. Gerente de captação e recepção NÃO têm login aqui
// (usam GuestPass e Sales). Gerente de vendas = seller (lê o contrato criado pela ponte; sem baixa nem auditoria). Administrativo =
// admin, o único papel do CRM que dá baixa manual, ativa contrato e abre painel de integrações e auditoria (shared/permissions.ts; não existe papel "operador").
// Nomes provisórios; os reais entram depois com --user.
const SALA = [
  "lucas.admin:admin:Lucas (admin geral)",
  "gerente.vendas:seller:Gerente de vendas",
  "administrativo:admin:Administrativo",
];
if (flags.sala) flags.user.unshift(...SALA);
if (flags.user.length === 0 && flags.rotate.length === 0) fail("Informe --perfil-sala ou ao menos um --user nome:papel[:Nome de exibição].");

const out = resolve(flags.out);
const file = join(out, "crm-users.json");
const requested = flags.user.map(entry => {
  const [username, role, ...display] = entry.split(":");
  if (!USERNAME.test(username ?? "")) fail(`Usuário inválido (a-z, 0-9, ponto, hífen, 3 a 58 caracteres): ${username}`);
  if (!ROLES.includes(role ?? "")) fail(`Papel inválido para ${username}: use ${ROLES.join(", ")}`);
  return { username, role, displayName: display.join(":").trim() || username };
});
if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(flags.envName)) fail("--env-name inválido (ex.: LOCAL_AUTH_USERS ou CRM_LOCAL_AUTH_USERS).");
if (requested.some(user => user.displayName.includes("'"))) fail("Nome de exibição sem apóstrofo (o valor vai entre aspas simples no .env).");
if (new Set(requested.map(user => user.username)).size !== requested.length) fail("Usuário repetido na lista.");

mkdirSync(out, { recursive: true });
const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { users: [] };
const byName = new Map(current.users.map(user => [user.username, user]));
for (const name of flags.rotate) if (!byName.has(name)) fail(`--rotate: ${name} não existe em ${file}`);

const password = () => randomBytes(12).toString("base64url"); // 16 caracteres
const hash = plain => {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(plain, salt, 64).toString("hex")}`;
};
const created = [], kept = [], rotated = [], credentials = [];
const issue = user => { const plain = password(); credentials.push(`${user.username}\t${user.role}\t${plain}`); return hash(plain); };
for (const wanted of requested) {
  const existing = byName.get(wanted.username);
  if (!existing) { byName.set(wanted.username, { ...wanted, passwordHash: issue(wanted) }); created.push(wanted.username); }
  else { byName.set(wanted.username, { ...existing, role: wanted.role, displayName: wanted.displayName }); kept.push(wanted.username); }
}
for (const name of flags.rotate) { const user = byName.get(name); byName.set(name, { ...user, passwordHash: issue(user) }); rotated.push(name); }

const users = [...byName.values()];
writeFileSync(file, JSON.stringify({ users }, null, 2), { mode: 0o600 });
writeFileSync(join(out, "crm-users.env"), `${flags.envName}='${JSON.stringify(users)}'\n`, { mode: 0o600 });
if (credentials.length) {
  // Uma linha por usuário: rotacionar SUBSTITUI a senha antiga (senão o smoke de login testaria uma senha já invalidada).
  const credFile = join(out, "crm-credentials.local.txt");
  const rows = new Map();
  if (existsSync(credFile)) for (const line of readFileSync(credFile, "utf8").trim().split("\n").slice(1)) { const [name] = line.split("\t"); if (name) rows.set(name, line); }
  for (const line of credentials) rows.set(line.split("\t")[0], line);
  writeFileSync(credFile, ["usuario\tpapel\tsenha_temporaria", ...rows.values()].join("\n") + "\n", { mode: 0o600 });
  chmodSync(credFile, 0o600);
}
chmodSync(file, 0o600);
chmodSync(join(out, "crm-users.env"), 0o600);
console.log(JSON.stringify({ created, kept, rotated, total: users.length, env: join(out, "crm-users.env"), credentials: credentials.length ? join(out, "crm-credentials.local.txt") : null }));
