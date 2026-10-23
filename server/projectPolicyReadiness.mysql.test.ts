import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { commercialFractions, commercialPolicyVersions, commercialProjectSettings, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// F1.12 em MySQL descartável: o checklist lê o que os motores leem. Comissão V1 incompleta (o caso da homologação P3.6) tem de aparecer como BLOQUEIO,
// e o script `policy:readiness` tem de sair com código 1 enquanto houver bloqueio.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const COMPLETE = JSON.stringify({ linerRate: 0.02, closerRate: 0.03, ftbRate: 0.01, cancellationDeadlineDay: 7, expectedPaymentDay: 10, eligiblePaymentMethods: ["pix"], basis: "eligible_receipt" });
const SALE_TERMS = JSON.stringify({ usageModel: "fixed_week", balanceInstallmentCount: 6, balanceCadenceMonths: 1 });

describe.skipIf(!integrationUrl)("checklist de política do projeto (MySQL real)", () => {
  let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let appRouter: typeof import("./routers")["appRouter"]; let userId = 0;
  const previousEnv = { ...process.env };
  const admin = () => appRouter.createCaller({ user: { id: userId, role: "admin", name: "Teste Política" } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    delete process.env.COMMISSION_POLICY_VERSIONING_ENABLED;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 }); db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `policy-${runId}`, name: "Teste Política", role: "admin" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  async function seed(label: string, options: { commission?: string | null; saleTerms?: Array<{ version: string; json: string; effectiveAt: Date }>; fractions?: number }) {
    const [resort] = await db.insert(resorts).values({ name: `Pol ${label} ${runId}`, externalKey: `pol-${label}-${runId}` }).$returningId();
    if (options.commission !== undefined) await db.insert(commercialProjectSettings).values({ resortId: resort.id, commissionPolicy: options.commission, cancellationPolicy: JSON.stringify({ penaltyRate: 0.1, penaltyBase: "paid", refundMode: "none" }), requiredContractDocuments: JSON.stringify(["Contrato assinado"]) } as never);
    for (const row of options.saleTerms ?? []) await db.insert(commercialPolicyVersions).values({ resortId: resort.id, policyType: "sale_terms", version: row.version, policyJson: row.json, effectiveAt: row.effectiveAt });
    if (options.fractions) {
      const [unit] = await db.insert(units).values({ resortId: resort.id, code: `U-${label}-${runId}` }).$returningId();
      for (let sequence = 1; sequence <= options.fractions; sequence++) await db.insert(commercialFractions).values({ resortId: resort.id, unitId: unit.id, code: `F-${label}-${runId}-${sequence}`, sequence, listPrice: "1000.00" });
    }
    return resort.id;
  }
  const past = new Date("2026-01-01T00:00:00Z");
  const check = (project: { checks: Array<{ key: string; ok: boolean; code: string | null }> }, key: string) => project.checks.find(item => item.key === key)!;

  it("projeto completo fica pronto; sem política de comissão BLOQUEIA com incomplete_project_policy", async () => {
    const ok = await seed("ok", { commission: COMPLETE, saleTerms: [{ version: "v1", json: SALE_TERMS, effectiveAt: past }], fractions: 2 });
    const noPolicy = await seed("semcom", { saleTerms: [{ version: "v1", json: SALE_TERMS, effectiveAt: past }], fractions: 2 });
    const onlyRates = await seed("sorates", { commission: JSON.stringify({ linerRate: 0.02, closerRate: 0.03, ftbRate: 0.04 }), saleTerms: [{ version: "v1", json: SALE_TERMS, effectiveAt: past }], fractions: 2 });
    const [readyProject] = await admin().projectSettings.readiness({ resortId: ok });
    expect(readyProject).toMatchObject({ ready: true, blocking: 0, warnings: 0 });
    for (const id of [noPolicy, onlyRates]) {
      const [project] = await admin().projectSettings.readiness({ resortId: id });
      expect(project!.ready).toBe(false);
      expect(check(project!, "commission_policy")).toMatchObject({ ok: false, code: "incomplete_project_policy" });
    }
  });

  it("condições da venda: ausentes, ambíguas (mesma vigência) e ilegíveis bloqueiam; futura ainda não vale", async () => {
    const missing = await seed("stmiss", { commission: COMPLETE, fractions: 1 });
    const future = await seed("stfut", { commission: COMPLETE, saleTerms: [{ version: "v1", json: SALE_TERMS, effectiveAt: new Date(Date.now() + 30 * 86_400_000) }], fractions: 1 });
    const ambiguous = await seed("stamb", { commission: COMPLETE, saleTerms: [{ version: "a", json: SALE_TERMS, effectiveAt: past }, { version: "b", json: SALE_TERMS, effectiveAt: past }], fractions: 1 });
    const invalid = await seed("stinv", { commission: COMPLETE, saleTerms: [{ version: "v1", json: JSON.stringify({ usageModel: "outro" }), effectiveAt: past }], fractions: 1 });
    const expected: Array<[number, string]> = [[missing, "SALE_TERMS_POLICY_MISSING"], [future, "SALE_TERMS_POLICY_MISSING"], [ambiguous, "SALE_TERMS_POLICY_AMBIGUOUS"], [invalid, "SALE_TERMS_POLICY_INVALID"]];
    for (const [id, code] of expected) {
      const [project] = await admin().projectSettings.readiness({ resortId: id });
      expect(project!.ready, code).toBe(false);
      expect(check(project!, "sale_terms_policy").code).toBe(code);
    }
  });

  it("com o versionamento da comissão ligado, vale a versão vigente (a mesma que o motor lê)", async () => {
    process.env.COMMISSION_POLICY_VERSIONING_ENABLED = "true";
    try {
      const id = await seed("ver", { commission: COMPLETE, saleTerms: [{ version: "v1", json: SALE_TERMS, effectiveAt: past }], fractions: 1 });
      await db.insert(commercialPolicyVersions).values({ resortId: id, policyType: "commission", version: "ilegivel", policyJson: JSON.stringify({ linerRate: 0.5 }), effectiveAt: past });
      const [project] = await admin().projectSettings.readiness({ resortId: id });
      // O cadastro está completo, mas a versão vigente não está: o motor fecha (não cai no cadastro), então o checklist também bloqueia.
      expect(check(project!, "commission_policy")).toMatchObject({ ok: false, code: "incomplete_project_policy" });
    } finally { delete process.env.COMMISSION_POLICY_VERSIONING_ENABLED; }
  });

  it("só administração lê o checklist", async () => {
    await expect(appRouter.createCaller({ user: { id: userId, role: "seller", name: "Vendedor" } } as never).projectSettings.readiness()).rejects.toThrow();
  });

  it("script policy:readiness sai com 1 enquanto há bloqueio e com 0 quando o projeto está pronto (somente leitura)", async () => {
    const ok = await seed("cliok", { commission: COMPLETE, saleTerms: [{ version: "v1", json: SALE_TERMS, effectiveAt: past }], fractions: 1 });
    const bad = await seed("clibad", { commission: "{}", saleTerms: [{ version: "v1", json: SALE_TERMS, effectiveAt: past }], fractions: 1 });
    const run = (id: number) => spawnSync(path.resolve(import.meta.dirname, "../node_modules/.bin/tsx"), ["scripts/project-policy-readiness.ts", `--resort=${id}`], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DATABASE_URL: integrationUrl }, encoding: "utf8" });
    const good = run(ok); const failing = run(bad);
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain("PRONTO");
    expect(failing.status, failing.stderr).toBe(1);
    expect(failing.stdout).toContain("BLOQUEADO");
    expect(failing.stdout).toContain("incomplete_project_policy");
  });
});
