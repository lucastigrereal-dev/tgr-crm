#!/usr/bin/env node

const strict = process.argv.includes("--strict");
const e2e = process.argv.includes("--e2e");
const profile = e2e ? "e2e" : strict ? "strict" : "local";

const env = process.env;
const errors = [];
const warnings = [];

const isNonEmpty = name => typeof env[name] === "string" && env[name].trim().length > 0;
const isUrl = name => {
  if (!isNonEmpty(name)) return false;
  try {
    const url = new URL(env[name]);
    return ["http:", "https:", "mysql:", "mysql2:"].includes(url.protocol);
  } catch {
    return false;
  }
};

const required = profile === "local"
  ? ["JWT_SECRET"]
  : ["DATABASE_URL", "JWT_SECRET", "VITE_APP_ID", "OAUTH_SERVER_URL", "OWNER_OPEN_ID"];

if (profile === "e2e") required.push("E2E_DATABASE_URL");
if (profile === "e2e" && env.E2E_STRICT === "1") {
  required.push("E2E_RUN_ID", "E2E_CONFIRM_ISOLATED");
}

for (const name of required) {
  if (!isNonEmpty(name)) errors.push(`${name} ausente`);
}

if (isNonEmpty("JWT_SECRET") && env.JWT_SECRET.trim().length < 32) {
  errors.push("JWT_SECRET precisa ter pelo menos 32 caracteres");
}

for (const name of [
  "DATABASE_URL",
  "E2E_DATABASE_URL",
  "OAUTH_SERVER_URL",
  "BUILT_IN_FORGE_API_URL",
  "ASAAS_API_URL",
]) {
  if (isNonEmpty(name) && !isUrl(name)) errors.push(`${name} não é uma URL válida`);
}

if (
  profile === "e2e" &&
  env.E2E_STRICT === "1" &&
  isNonEmpty("E2E_CONFIRM_ISOLATED") &&
  env.E2E_CONFIRM_ISOLATED !== "I_CONFIRM_ISOLATED_E2E"
) {
  errors.push("E2E_CONFIRM_ISOLATED não contém a confirmação exata exigida");
}

if (strict && !isNonEmpty("BUILT_IN_FORGE_API_URL")) warnings.push("BUILT_IN_FORGE_API_URL ausente; IA, storage e integrações Manus podem não funcionar");
if (strict && !isNonEmpty("BUILT_IN_FORGE_API_KEY")) warnings.push("BUILT_IN_FORGE_API_KEY ausente; chamadas server-side do Forge podem falhar");
if (strict && !isNonEmpty("ASAAS_API_KEY")) warnings.push("ASAAS_API_KEY ausente; cobrança Asaas ficará indisponível");
if (strict && !isNonEmpty("ASAAS_WEBHOOK_TOKEN")) warnings.push("ASAAS_WEBHOOK_TOKEN ausente; webhook Asaas não deve ser habilitado");
if (env.NODE_ENV === "production" && env.JWT_SECRET?.trim() === "troque-por-um-segredo-forte") errors.push("JWT_SECRET ainda usa o placeholder do exemplo");

console.log(`TGR config doctor · perfil=${profile}`);
console.log(`Node ${process.version} · NODE_ENV=${env.NODE_ENV || "não definido"}`);

if (errors.length) {
  console.error("\nERROS que bloqueiam o perfil:");
  for (const error of errors) console.error(`- ${error}`);
}

if (warnings.length) {
  console.warn("\nAVISOS:");
  for (const warning of warnings) console.warn(`- ${warning}`);
}

if (!errors.length && !warnings.length) console.log("OK: configuração mínima validada sem avisos.");
else if (!errors.length) console.log("OK: configuração mínima validada; revise os avisos antes de liberar.");

process.exitCode = errors.length ? 1 : 0;
