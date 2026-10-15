#!/usr/bin/env node
// P-05 (piloto na sala): o que a primeira venda do Sales precisa encontrar no CRM, sem ninguém configurar à mão.
// Cria (idempotente) o empreendimento com o MESMO nome do projeto do Sales, 1 UH sintética (SYN-UH-01), 10 cotas disponíveis
// e a política `sale_terms` (sem ela a ponte recusa a venda: PROJECT_NOT_MAPPED / SALE_TERMS_POLICY_MISSING). Só dado sintético:
// o preço das cotas fica vazio e nenhum cliente é criado. A chave externa do projeto o próprio Sales grava na 1ª venda.
// Uso: DATABASE_URL=mysql://... node scripts/pilot-seed-sala.mjs [--project-name "Piloto da sala"] [--units 1] [--quotas 10] [--balance-installments 12]
// Pode rodar junto com o pilot-users.mjs e quantas vezes quiser: rodar de novo não duplica nada. Nunca imprime a URL do banco.
import mysql from "mysql2/promise";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const fail = message => { console.error(message); process.exit(1); };
const intOpt = (name, fallback, min, max) => {
  const value = Number(opt(name, String(fallback)));
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} deve ser inteiro entre ${min} e ${max}.`);
  return value;
};
for (const arg of args) if (arg.startsWith("--") && !["--project-name", "--units", "--quotas", "--balance-installments"].includes(arg)) fail(`Argumento desconhecido: ${arg}`);

const url = process.env.DATABASE_URL;
if (!url) fail("Informe DATABASE_URL.");
const projectName = (opt("--project-name", "Piloto da sala") ?? "").trim();
if (projectName.length < 3 || projectName.length > 180) fail("--project-name deve ter de 3 a 180 caracteres e igualar o nome do projeto no Sales.");
const unitCount = intOpt("--units", 1, 1, 50);
const quotasPerUnit = intOpt("--quotas", 10, 1, 104);
const balanceInstallments = intOpt("--balance-installments", 12, 1, 360);
const POLICY_VERSION = "SYN-PILOTO-SALA-1";
const pad = n => String(n).padStart(2, "0");

const connection = await mysql.createConnection({ uri: url });
try {
  await connection.beginTransaction();
  await connection.query("INSERT IGNORE INTO resorts (name, city, state, status) VALUES (?, 'Natal', 'RN', 'active')", [projectName]);
  const [[resort]] = await connection.query("SELECT id, externalKey FROM resorts WHERE name = ?", [projectName]);

  const unitRows = Array.from({ length: unitCount }, (_, i) => [resort.id, `SYN-UH-${pad(i + 1)}`, "SYN", 4, 2, "active"]);
  await connection.query("INSERT IGNORE INTO units (resortId, code, category, capacity, beds, status) VALUES ?", [unitRows]);
  // Só as UHs pedidas, por código exato (LIKE trataria "_" como curinga e pegaria UH alheia).
  const [units] = await connection.query("SELECT id, code FROM units WHERE resortId = ? AND code IN (?) ORDER BY code", [resort.id, unitRows.map(row => row[1])]);

  const fractionRows = units.flatMap(unit => Array.from({ length: quotasPerUnit }, (_, q) => [resort.id, unit.id, `${unit.code}-C${pad(q + 1)}`, q + 1, "available"]));
  await connection.query("INSERT IGNORE INTO commercial_fractions (resortId, unitId, code, sequence, status) VALUES ?", [fractionRows]);

  // Política antiga e vigente (efetiva desde o início do ano) para valer na data da venda; a versão é única, então não duplica.
  const policy = { usageModel: "flexible_week", balanceInstallmentCount: balanceInstallments, balanceCadenceMonths: 1, description: "SINTÉTICO do piloto da sala; substituir pela política real depois." };
  await connection.query(
    "INSERT IGNORE INTO commercial_policy_versions (resortId, policyType, version, policyJson, effectiveAt) VALUES (?, 'sale_terms', ?, ?, '2026-01-01 00:00:00')",
    [resort.id, POLICY_VERSION, JSON.stringify(policy)],
  );
  await connection.query(
    "INSERT IGNORE INTO audit_logs (entityType, entityId, action, summary, idempotencyKey) VALUES ('pilot_seed', ?, 'seeded', ?, ?)",
    [String(resort.id), `Seed sintético do piloto da sala: ${units.length} UH, ${fractionRows.length} cotas, política sale_terms ${POLICY_VERSION}.`, `pilot-seed-sala:${resort.id}`],
  );
  await connection.commit();

  const [[counts]] = await connection.query(
    `SELECT (SELECT COUNT(*) FROM units WHERE resortId = ?) AS units,
            (SELECT COUNT(*) FROM commercial_fractions WHERE resortId = ?) AS fractions,
            (SELECT COUNT(*) FROM commercial_fractions WHERE resortId = ? AND status = 'available') AS available,
            (SELECT COUNT(*) FROM commercial_policy_versions WHERE resortId = ? AND policyType = 'sale_terms' AND retiredAt IS NULL) AS saleTermsPolicies`,
    [resort.id, resort.id, resort.id, resort.id],
  );
  console.log(JSON.stringify({ project: projectName, resortId: resort.id, mappedToSales: Boolean(resort.externalKey), units: Number(counts.units), fractions: Number(counts.fractions), available: Number(counts.available), saleTermsPolicies: Number(counts.saleTermsPolicies) }));
} catch (error) {
  await connection.rollback().catch(() => {});
  fail(`Seed falhou: ${error instanceof Error ? error.message : "erro desconhecido"}`);
} finally {
  await connection.end();
}
