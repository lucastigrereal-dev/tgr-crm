#!/usr/bin/env node
// P-06 (piloto na sala): gera os usuários de login local do CRM (LOCAL_AUTH_USERS) com senha temporária.
// Idempotente: quem já está em <out>/crm-users.json mantém a senha; só os novos ganham senha. `--rotate nome` troca a de um.
// Senhas em texto ficam SÓ em <out>/crm-credentials.local.txt (modo 600, fora do Git); o stdout não mostra senha nem hash.
// --env-name troca o nome da variável no .env gerado (o compose portátil da Suite usa CRM_LOCAL_AUTH_USERS).
// Uso: node scripts/pilot-users.mjs [--perfil-sala] --out <pasta-fora-do-repo> --user ana.adm:admin:"Ana Administrativo" --user bia.fin:finance
import { randomBytes, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROLES = ["admin", "seller", "finance", "service"];
const USERNAME = /^[a-z0-9._-]{3,58}$/;
const args = process.argv.slice(2);
const flags = { out: "", user: [], rotate: [], sala: false, envName: "LOCAL_AUTH_USERS", primary: "lucas.admin" };
for (let i = 0; i < args.length; i += 1) {
  const key = args[i];
  if (key === "--out") flags.out = args[++i] ?? "";
  else if (key === "--user") flags.user.push(args[++i] ?? "");
  else if (key === "--env-name") flags.envName = args[++i] ?? "";
  else if (key === "--primary") flags.primary = args[++i] ?? "";
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
// O admin geral (lucas.admin) NÃO entra aqui: é o LOCAL_AUTH_USERNAME do runtime (start-pilot.ps1 / compose) e o CRM recusa repeti-lo em
// LOCAL_AUTH_USERS (a lista inteira ficaria desabilitada). Se o runtime usar outro nome de admin primário, passe --primary <nome>.
const SALA = [
  "gerente.vendas:seller:Gerente de vendas",
  "administrativo:admin:Administrativo",
];
if (flags.sala) flags.user.unshift(...SALA);
if (flags.user.length === 0 && flags.rotate.length === 0) fail("Informe --perfil-sala ou ao menos um --user nome:papel[:Nome de exibição].");

const primary = flags.primary.trim().toLowerCase();
for (const entry of flags.user) {
  if (primary && (entry.split(":")[0] ?? "").trim().toLowerCase() === primary) fail(`"${primary}" é o admin primário do runtime (LOCAL_AUTH_USERNAME) e não pode repetir em LOCAL_AUTH_USERS: tire do --user ou use --primary <outro nome>.`);
}
const out = resolve(flags.out);
// As senhas em texto não podem cair dentro do checkout (um `git add .` as commitaria): recusa --out dentro do repositório.
// Resolve links simbólicos: usa o caminho real do ancestral existente mais próximo (a pasta pode ainda não existir).
// No Windows o chmod 0o600 não restringe nada (a ACL herdada continua valendo): aplica ACL só do dono, como o start-pilot.ps1 faz com icacls.
function lockDown(path) {
  chmodSync(path, 0o600);
  if (process.platform !== "win32") return true;
  const owner = process.env.USERNAME;
  const result = owner ? spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `${owner}:(R,W)`], { encoding: "utf8" }) : { status: 1 };
  return result.status === 0;
}
// Segredo só é gravado DEPOIS de protegido: cria o arquivo vazio, trava, e só então escreve. Se a trava falhar, apaga e para (nada de senha solta).
function writeSecret(path, content) {
  writeFileSync(path, "", { mode: 0o600 });
  if (!lockDown(path)) { try { unlinkSync(path); } catch { /* já sumiu */ } fail(`Não consegui restringir ${path} só ao seu usuário (icacls); removi o arquivo. Use uma pasta privada e tente de novo.`); }
  writeFileSync(path, content, { mode: 0o600 });
}
function realLocation(path) {
  let probe = path;
  const rest = [];
  while (!existsSync(probe)) { rest.unshift(probe.slice(dirname(probe).length + 1)); const up = dirname(probe); if (up === probe) break; probe = up; }
  return join(realpathSync(probe), ...rest);
}
const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const fromRepo = relative(repoRoot, realLocation(out));
if (fromRepo === "" || (fromRepo !== ".." && !fromRepo.startsWith(".." + sep) && !isAbsolute(fromRepo))) fail("--out está dentro do repositório: use uma pasta fora dele, para as senhas não irem pro Git.");
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
// Os arquivos de saída não podem ser links simbólicos (nem soltos): a escrita seguiria o link e poderia cair dentro do repositório.
for (const name of ["crm-users.json", "crm-users.env", "crm-credentials.local.txt"]) {
  const target = join(out, name);
  let stat = null;
  try { stat = lstatSync(target); } catch { /* não existe: ok */ }
  if (stat && (!stat.isFile() || stat.nlink > 1)) fail(`${target} não é um arquivo comum de um só nome (link simbólico ou físico?): apague-o e rode de novo.`);
}
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

// O primário do runtime não pode estar entre os extras salvos (uma rodada antiga pode tê-lo gravado): o CRM recusa a lista inteira.
if (primary && byName.has(primary)) fail(`"${primary}" já está salvo em ${file} como usuário extra, mas é o admin primário do runtime (LOCAL_AUTH_USERNAME): tire-o do crm-users.json antes de gerar de novo.`);
const users = [...byName.values()];
// Uma linha por usuário: rotacionar SUBSTITUI a senha antiga (senão o smoke de login testaria uma senha já invalidada) e a
// coluna do papel acompanha o papel atual mesmo quando a senha é mantida (o smoke lê o papel esperado daqui).
// A leitura e a validação do arquivo antigo vêm ANTES de gravar qualquer coisa: cabeçalho ausente/alterado aborta sem perder a 1ª conta.
const CREDENTIALS_HEADER = "usuario\tpapel\tsenha_temporaria";
const credFile = join(out, "crm-credentials.local.txt");
const rows = new Map();
if (existsSync(credFile)) {
  const saved = readFileSync(credFile, "utf8").trim().split("\n");
  if (saved[0]?.trim() !== CREDENTIALS_HEADER) fail(`${credFile} está sem o cabeçalho esperado (arquivo alterado?): apague-o e gere de novo, ou restaure o cabeçalho.`);
  for (const line of saved.slice(1)) {
    const [name, , plain] = line.split("\t");
    const user = name ? byName.get(name) : undefined;
    if (user && plain) rows.set(name, `${name}\t${user.role}\t${plain}`);
  }
}
for (const line of credentials) rows.set(line.split("\t")[0], line);
if (credentials.length || existsSync(credFile)) writeSecret(credFile, [CREDENTIALS_HEADER, ...rows.values()].join("\n") + "\n");
writeSecret(file, JSON.stringify({ users }, null, 2));
writeSecret(join(out, "crm-users.env"), `${flags.envName}='${JSON.stringify(users)}'\n`);
console.log(JSON.stringify({ created, kept, rotated, total: users.length, env: join(out, "crm-users.env"), credentials: credentials.length ? credFile : null }));
