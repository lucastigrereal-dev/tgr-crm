// F1.12: confere a política de cada empreendimento ativo ANTES do 1º dia. Somente leitura. Sai com código 1 se algum item BLOQUEANTE falhar
// (comissão V1 incompleta = incomplete_project_policy, condições da venda ausentes/ambíguas/inválidas) ou se não houver empreendimento ativo.
// Uso: pnpm exec tsx scripts/project-policy-readiness.ts [--resort=ID] [--json]    (lê DATABASE_URL; nunca escreve)
import { getDb } from "../server/db";
import { loadProjectReadiness } from "../server/projectPolicyReadiness";

const args = process.argv.slice(2);
const resortArg = args.find(arg => arg.startsWith("--resort="));
const resortId = resortArg ? Number(resortArg.slice("--resort=".length)) : undefined;
const asJson = args.includes("--json");

if (resortArg && !(Number.isInteger(resortId) && (resortId as number) > 0)) { console.error("--resort deve ser um número inteiro positivo."); process.exit(2); }
const db = await getDb();
if (!db) { console.error("Banco indisponível: defina DATABASE_URL."); process.exit(2); }
const report = await loadProjectReadiness(db, { resortId });
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  for (const project of report) {
    console.log(`${project.ready ? "PRONTO " : "BLOQUEADO"} ${project.resortName} (#${project.resortId}): ${project.blocking} bloqueio(s), ${project.warnings} aviso(s)`);
    for (const check of project.checks.filter(item => !item.ok)) console.log(`  [${check.severity === "blocking" ? "BLOQUEIA" : "aviso"}] ${check.label}${check.code ? ` (${check.code})` : ""}: ${check.detail}`);
  }
  if (!report.length) console.log("Nenhum empreendimento ativo encontrado.");
}
const failed = !report.length || report.some(project => !project.ready);
process.exit(failed ? 1 : 0);
