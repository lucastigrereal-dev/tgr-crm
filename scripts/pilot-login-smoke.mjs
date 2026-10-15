#!/usr/bin/env node
// P-06 / D2 (piloto na sala): confere o login de cada usuário do piloto contra o CRM que está no ar.
// Uso: node scripts/pilot-login-smoke.mjs --base https://crm.empresa.com.br --credentials <pasta>/crm-credentials.local.txt
// Imprime só PASS/FAIL por usuário e papel (nunca a senha). Também confere /api/health/ready e que senha errada é recusada.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (opt("--base") ?? "").replace(/\/$/, "");
const credentialsFile = opt("--credentials");
if (!base || !credentialsFile) { console.error("Uso: --base <url do CRM> --credentials <crm-credentials.local.txt>"); process.exit(2); }

const rows = readFileSync(credentialsFile, "utf8").trim().split("\n").slice(1).map(line => line.split("\t"));
let failed = 0;
const report = (ok, label, detail = "") => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " " + detail : ""}`); };

const ready = await fetch(base + "/api/health/ready").catch(() => null);
report(Boolean(ready?.ok), "health/ready", ready ? `(${ready.status})` : "(sem resposta)");

async function login(username, password) {
  const response = await fetch(base + "/api/trpc/auth.localLogin", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: { username, password } }),
  });
  const cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(";")[0]).join("; ");
  return { status: response.status, cookie };
}

for (const [username, role, password] of rows) {
  if (!username || !role || !password) continue;
  const bad = await login(username, password + "x");
  report(bad.status === 401, `${username}: senha errada recusada`, `(${bad.status})`);
  const good = await login(username, password);
  if (good.status !== 200 || !good.cookie) { report(false, `${username}: login`, `(${good.status})`); continue; }
  const me = await fetch(base + "/api/trpc/auth.me", { headers: { Cookie: good.cookie } });
  const body = await me.json().catch(() => ({}));
  const user = body?.result?.data?.json;
  report(user?.role === role && user?.openId === `local:${username}`, `${username}: entrou como ${user?.role ?? "?"}`, `(esperado ${role})`);
}
console.log(failed === 0 ? "RESULTADO: PASS" : `RESULTADO: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
