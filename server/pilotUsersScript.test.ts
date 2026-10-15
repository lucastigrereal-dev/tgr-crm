import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyLocalPassword } from "./localAuth";

const root = process.cwd();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(out: string, ...args: string[]) {
  return spawnSync(process.execPath, ["scripts/pilot-users.mjs", "--out", out, ...args], { cwd: root, encoding: "utf8", timeout: 20_000 });
}
const newDir = () => { const dir = mkdtempSync(join(tmpdir(), "pilot-users-")); dirs.push(dir); return dir; };
const credentials = (dir: string) => Object.fromEntries(readFileSync(join(dir, "crm-credentials.local.txt"), "utf8").trim().split("\n").slice(1).map(line => { const [user, , password] = line.split("\t"); return [user!, password!]; }));

describe("P-06 usuários do piloto do CRM", () => {
  it("cria usuários com senha que o login local aceita, sem imprimir senha nem hash", () => {
    const dir = newDir();
    const result = run(dir, "--user", "ana.adm:admin:Ana Administrativo", "--user", "bia.fin:finance");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/scrypt:|senha/i);
    expect(JSON.parse(result.stdout)).toMatchObject({ created: ["ana.adm", "bia.fin"], kept: [], rotated: [], total: 2 });
    const env = readFileSync(join(dir, "crm-users.env"), "utf8");
    const users = JSON.parse(env.trim().replace(/^LOCAL_AUTH_USERS='/, "").replace(/'$/, "")) as Array<{ username: string; role: string; displayName: string; passwordHash: string }>;
    expect(users.map(u => [u.username, u.role, u.displayName])).toEqual([["ana.adm", "admin", "Ana Administrativo"], ["bia.fin", "finance", "bia.fin"]]);
    const plain = credentials(dir);
    for (const user of users) {
      expect(plain[user.username]!.length).toBeGreaterThanOrEqual(12);
      expect(verifyLocalPassword(plain[user.username]!, user.passwordHash)).toBe(true);
    }
    for (const name of ["crm-users.json", "crm-users.env", "crm-credentials.local.txt"]) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
  });

  it("é idempotente: repetir não troca senha nem duplica; só o novo ganha credencial; --rotate troca uma", () => {
    const dir = newDir();
    expect(run(dir, "--user", "ana.adm:admin").status).toBe(0);
    const before = readFileSync(join(dir, "crm-users.json"), "utf8");
    const again = run(dir, "--user", "ana.adm:admin");
    expect(JSON.parse(again.stdout)).toMatchObject({ created: [], kept: ["ana.adm"], total: 1, credentials: null });
    expect(readFileSync(join(dir, "crm-users.json"), "utf8")).toBe(before);
    const more = run(dir, "--user", "ana.adm:admin", "--user", "caio.vendas:seller");
    expect(JSON.parse(more.stdout)).toMatchObject({ created: ["caio.vendas"], kept: ["ana.adm"], total: 2 });
    const oldPassword = credentials(dir)["ana.adm"]!;
    const rotated = run(dir, "--rotate", "ana.adm");
    expect(JSON.parse(rotated.stdout)).toMatchObject({ rotated: ["ana.adm"] });
    const users = JSON.parse(readFileSync(join(dir, "crm-users.json"), "utf8")).users as Array<{ username: string; passwordHash: string }>;
    expect(verifyLocalPassword(oldPassword, users.find(u => u.username === "ana.adm")!.passwordHash)).toBe(false);
    // o arquivo de credenciais troca a senha da linha (uma linha por usuário), para o smoke não testar senha invalidada
    const lines = readFileSync(join(dir, "crm-credentials.local.txt"), "utf8").trim().split("\n");
    expect(lines.filter(line => line.startsWith("ana.adm\t"))).toHaveLength(1);
    expect(lines).toHaveLength(3);
    expect(credentials(dir)["ana.adm"]).not.toBe(oldPassword);
    expect(verifyLocalPassword(credentials(dir)["ana.adm"]!, users.find(u => u.username === "ana.adm")!.passwordHash)).toBe(true);
  });

  it("--perfil-sala cria só os 3 perfis do CRM (§1.2 do plano): captação e recepção não têm login", () => {
    const dir = newDir();
    const result = run(dir, "--perfil-sala");
    expect(JSON.parse(result.stdout)).toMatchObject({ created: ["lucas.admin", "gerente.vendas", "administrativo"], total: 3 });
    const users = JSON.parse(readFileSync(join(dir, "crm-users.json"), "utf8")).users as Array<{ username: string; role: string }>;
    expect(Object.fromEntries(users.map(u => [u.username, u.role]))).toEqual({ "lucas.admin": "admin", "gerente.vendas": "seller", administrativo: "admin" });
    const again = run(dir, "--perfil-sala", "--user", "maria.souza:admin:Maria Souza");
    expect(JSON.parse(again.stdout)).toMatchObject({ created: ["maria.souza"], total: 4 });
    // o resultado é aceito de verdade pelo CRM (config-doctor valida LOCAL_AUTH_USERS)
    const env = readFileSync(join(dir, "crm-users.env"), "utf8").trim().replace(/^LOCAL_AUTH_USERS='/, "").replace(/'$/, "");
    const doctor = spawnSync(process.execPath, ["scripts/config-doctor.mjs", "--strict"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, DATABASE_URL: "mysql://tgr:x@127.0.0.1:3306/tgr_crm_pilot", JWT_SECRET: "local-pilot-secret-with-at-least-32-characters", VITE_APP_ID: "tgr-crm-pilot",
        LOCAL_AUTH_ENABLED: "1", LOCAL_AUTH_USERNAME: "admin.crm", LOCAL_AUTH_PASSWORD_HASH: "scrypt:00112233445566778899aabbccddeeff:" + "ab".repeat(64), LOCAL_STORAGE_DIRECTORY: "/data/documents", LOCAL_AUTH_USERS: env },
    });
    expect(doctor.status).toBe(0);
  });

  it("mudar o papel de quem já existe mantém a senha e atualiza o papel na linha de credencial", () => {
    const dir = newDir();
    expect(run(dir, "--user", "ana.adm:admin").status).toBe(0);
    const password = credentials(dir)["ana.adm"]!;
    expect(run(dir, "--user", "ana.adm:seller").status).toBe(0);
    const line = readFileSync(join(dir, "crm-credentials.local.txt"), "utf8").trim().split("\n").find(l => l.startsWith("ana.adm\t"))!;
    expect(line.split("\t")).toEqual(["ana.adm", "seller", password]);
  });

  it("recusa --out dentro do repositório (senhas não podem ir pro Git)", () => {
    const result = spawnSync(process.execPath, ["scripts/pilot-users.mjs", "--out", "tmp-credenciais", "--user", "ana.adm:admin"], { cwd: root, encoding: "utf8", timeout: 20_000 });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("dentro do repositório");
  });

  it("--env-name escreve o valor entre aspas simples com o nome pedido (compose portátil)", () => {
    const dir = newDir();
    expect(run(dir, "--user", "ana.adm:admin", "--env-name", "CRM_LOCAL_AUTH_USERS").status).toBe(0);
    const line = readFileSync(join(dir, "crm-users.env"), "utf8").trim();
    expect(line.startsWith("CRM_LOCAL_AUTH_USERS='[{")).toBe(true);
    expect(line.endsWith("}]'")).toBe(true);
    expect(run(dir, "--user", "x.yz:admin", "--env-name", "minusculo").status).toBe(1);
    expect(run(dir, "--user", "x.yz:admin:O'Neil").status).toBe(1);
  });

  it("recusa usuário ou papel inválido e rotacionar quem não existe", () => {
    const dir = newDir();
    expect(run(dir, "--user", "Ana Maiuscula:admin").status).toBe(1);
    expect(run(dir, "--user", "ana.adm:dono").status).toBe(1);
    expect(run(dir, "--user", "ana.adm:admin", "--user", "ana.adm:seller").status).toBe(1);
    expect(run(dir, "--rotate", "ninguem").status).toBe(1);
    expect(run(dir).status).toBe(1);
  });
});
