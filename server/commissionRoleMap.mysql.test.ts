import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, commissionRoleMapVersions, contractCommissionRoleMaps, contracts, customers, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { DEFAULT_COMMISSION_V2_ROLE_MAP, parseCommissionRoleMap } from "./commissionRoleMap";
import { COMMISSION_V2_ROLE_MAP, commissionRoleMapForContract } from "./installmentCommissions";
import { fixContractCommissionRoleMapAtFormalization } from "./commissionRoleMapSnapshot";

const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe("mapa de papéis da comissão (puro)", () => {
  it("o padrão é a constante de hoje e a validação exige 3 papéis, destinos conhecidos e sem repetição", () => {
    expect(DEFAULT_COMMISSION_V2_ROLE_MAP).toEqual(COMMISSION_V2_ROLE_MAP);
    expect(parseCommissionRoleMap({ captador: "liner", consultor: "promoter", fechador: "closer" })).toEqual({ captador: "liner", consultor: "promoter", fechador: "closer" });
    for (const bad of [null, {}, { captador: "promoter", consultor: "promoter", fechador: "closer" }, { captador: "x", consultor: "liner", fechador: "closer" }, { captador: "promoter", consultor: "liner", fechador: "closer", extra: "liner" }, { captador: "promoter", consultor: "liner" }]) expect(parseCommissionRoleMap(bad)).toBeNull();
  });
  it("zero mudança com o V2 travado: o mapa só é lido dentro do caminho V2 e, com a flag OFF, é a constante sem tocar o banco", async () => {
    const source = readFileSync(path.resolve(__dirname, "installmentCommissions.ts"), "utf8");
    expect(source.match(/resolveContractCommissionRoleMap\(/g)).toHaveLength(1); // a ÚNICA chamada, dentro de v2Rows
    expect(source.indexOf("await resolveContractCommissionRoleMap(")).toBeGreaterThan(source.indexOf("const v2Rows = async"));
    expect(source.indexOf("await resolveContractCommissionRoleMap(")).toBeLessThan(source.indexOf("const pinned ="));
    ENV.commissionRoleMapEnabled = false;
    expect(await commissionRoleMapForContract(undefined as never, 1)).toEqual({ map: COMMISSION_V2_ROLE_MAP });
  });
});

describe.skipIf(!integrationUrl)("mapa de papéis da comissão em MySQL real (0083 PROPOSTA inteira em banco descartável)", () => {
  let admin: mysql.Pool; let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let scratch = ""; let adminId = 0; let customerId = 0;
  const previousEnv = { ...process.env }; const previousFlag = ENV.commissionRoleMapEnabled;
  const caller = async (role: "admin" | "finance" = "admin") => (await import("./routers/commissionRoleMap")).commissionRoleMapRouter.createCaller({ user: { id: adminId, role } } as never);
  let n = 0;
  const newContract = async () => (await db.insert(contracts).values({ number: `RM-${++n}-${runId}`, customerId, usageModel: "fixed_week", status: "active", totalAmount: "1000.00" } as never).$returningId())[0]!.id;

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratch = `${database.replace(/_test$/i, "")}_rm${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["users", "customers", "contracts", "audit_logs", "domain_events"]) await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const url = new URL(integrationUrl!); url.pathname = `/${scratch}`;
    process.env.DATABASE_URL = url.toString();
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 6 }); db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0083_commission_role_map.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    [{ id: adminId }] = await db.insert(users).values({ openId: `rm-${runId}`, name: "Admin SYN", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `SYN RM ${runId}`, email: `syn.rm.${runId}@example.test`, status: "active" }).$returningId();
    ENV.commissionRoleMapEnabled = true;
  });
  afterAll(async () => { ENV.commissionRoleMapEnabled = previousFlag; process.env = previousEnv; await pool?.end(); if (scratch) await admin?.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await admin?.end(); });

  it("sem versão salva vale a constante e o contrato fixa o snapshot (versão 0)", async () => {
    const id = await newContract();
    expect(await commissionRoleMapForContract(db as never, id)).toEqual({ map: COMMISSION_V2_ROLE_MAP });
    expect((await db.select().from(contractCommissionRoleMaps).where(eq(contractCommissionRoleMaps.contractId, id)))[0]).toMatchObject({ mapVersion: 0 });
  });

  it("versiona com histórico e auditoria; contrato JÁ fixado mantém o mapa antigo, contrato novo pega o vigente", async () => {
    const api = await caller();
    const old = await newContract();
    await commissionRoleMapForContract(db as never, old); // fixa o padrão
    const saved = await api.save({ roleMap: { captador: "liner", consultor: "promoter", fechador: "closer" } });
    expect(saved.version).toBe(1);
    expect(await commissionRoleMapForContract(db as never, old)).toEqual({ map: COMMISSION_V2_ROLE_MAP }); // snapshot manda
    const fresh = await newContract();
    expect(await commissionRoleMapForContract(db as never, fresh)).toEqual({ map: { captador: "liner", consultor: "promoter", fechador: "closer" } });
    expect((await api.current())).toMatchObject({ version: 1, isDefault: false });
    expect((await api.history()).map(h => [h.version, h.createdByUserId])).toEqual([[1, adminId]]);
    expect((await db.select().from(auditLogs)).filter(a => a.action === "version_saved")).toHaveLength(1);
  });

  it("corrida entre duas parcelas do mesmo contrato fixa um único snapshot; mapa inválido, não-admin e flag OFF são recusados", async () => {
    const id = await newContract();
    const maps = await Promise.all([1, 2, 3, 4].map(() => db.transaction(tx => commissionRoleMapForContract(tx as never, id))));
    expect(maps.every(m => "map" in m)).toBe(true);
    expect(new Set(maps.map(m => JSON.stringify(m))).size).toBe(1);
    expect(await db.select().from(contractCommissionRoleMaps).where(eq(contractCommissionRoleMaps.contractId, id))).toHaveLength(1);
    const api = await caller();
    await expect(api.save({ roleMap: { captador: "liner", consultor: "liner", fechador: "closer" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await caller("finance")).save({ roleMap: DEFAULT_COMMISSION_V2_ROLE_MAP })).rejects.toMatchObject({ code: "FORBIDDEN" });
    ENV.commissionRoleMapEnabled = false;
    try { await expect(api.current()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); } finally { ENV.commissionRoleMapEnabled = true; }
  });

  it("(1) o snapshot nasce na FORMALIZAÇÃO: contrato assinado com o mapa v1 paga com v1 mesmo se um save v2 vier antes da entrada; contrato antigo (sem snapshot) cai no fallback do lançamento", async () => {
    const api = await caller();
    await api.save({ roleMap: DEFAULT_COMMISSION_V2_ROLE_MAP }); // vigente = padrão
    const formalized = await newContract();
    await db.transaction(tx => fixContractCommissionRoleMapAtFormalization(tx as never, formalized)); // na mesma tx da formalização
    expect((await db.select().from(contractCommissionRoleMaps).where(eq(contractCommissionRoleMaps.contractId, formalized)))[0]).toBeDefined();
    await api.save({ roleMap: { captador: "closer", consultor: "promoter", fechador: "liner" } }); // admin muda DEPOIS da assinatura
    expect(await commissionRoleMapForContract(db as never, formalized)).toEqual({ map: DEFAULT_COMMISSION_V2_ROLE_MAP }); // entrada paga depois: continua v-antiga
    const legacy = await newContract(); // sem hook (contrato anterior à flag)
    expect(await commissionRoleMapForContract(db as never, legacy)).toEqual({ map: { captador: "closer", consultor: "promoter", fechador: "liner" } }); // fallback fixa no lançamento
  });

  it("(1) o gancho da formalização: erro comum não derruba a tx (savepoint); deadlock/lock timeout sobem; flag OFF não toca o banco; está nos 2 pontos de formalização", async () => {
    const wrap = (errno: number, code: string) => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error(code), { errno, code }) });
    for (const err of [wrap(1213, "ER_LOCK_DEADLOCK"), wrap(1205, "ER_LOCK_WAIT_TIMEOUT")]) {
      const mask = { transaction: async (fn: (t: unknown) => Promise<void>) => { await fn({ select: () => { throw err; } }); throw new Error("rollback to savepoint failed"); } } as never;
      await expect(fixContractCommissionRoleMapAtFormalization(mask, 1)).rejects.toBe(err);
    }
    const common = { transaction: async (fn: (t: unknown) => Promise<void>) => { await fn({ select: () => { throw new Error("Table doesn't exist"); } }); } } as never;
    await expect(fixContractCommissionRoleMapAtFormalization(common, 1)).resolves.toBeUndefined();
    ENV.commissionRoleMapEnabled = false;
    try { await expect(fixContractCommissionRoleMapAtFormalization(undefined as never, 1)).resolves.toBeUndefined(); } finally { ENV.commissionRoleMapEnabled = true; }
    for (const file of ["routers/contracts.ts", "salesCommandBridge.ts"]) expect(readFileSync(path.resolve(__dirname, file), "utf8"), file).toMatch(/fixContractCommissionRoleMapAtFormalization\(tx, contractId\);[^\n]*\n\s*await eligibilityHook/);
  });

  it("(2) o snapshot é relido com FOR UPDATE depois do INSERT ON DUPLICATE (REPEATABLE READ não enxerga commit concorrente)", () => {
    const source = readFileSync(path.resolve(__dirname, "commissionRoleMapSnapshot.ts"), "utf8");
    expect(source).toMatch(/onDuplicateKeyUpdate[\s\S]*?const \[fixed\][^\n]*\.for\("update"\)/);
  });

  it("(3) snapshot ilegível ou versão vigente inválida BLOQUEIA (nunca cai na constante nem grava), e o motor retém com rastro", async () => {
    const bad = await newContract();
    await db.insert(contractCommissionRoleMaps).values({ contractId: bad, mapVersion: 1, roleMap: "{lixo" });
    expect(await commissionRoleMapForContract(db as never, bad)).toEqual({ blocked: "snapshot_invalid" });
    const dup = await newContract();
    await db.insert(contractCommissionRoleMaps).values({ contractId: dup, mapVersion: 1, roleMap: JSON.stringify({ captador: "liner", consultor: "liner", fechador: "closer" }) });
    expect(await commissionRoleMapForContract(db as never, dup)).toEqual({ blocked: "snapshot_invalid" });
    const maxVersion = (await db.select().from(commissionRoleMapVersions)).reduce((m, r) => Math.max(m, r.version), 0);
    await db.insert(commissionRoleMapVersions).values({ version: maxVersion + 1, roleMap: "{lixo", createdByUserId: adminId });
    const fresh = await newContract();
    expect(await commissionRoleMapForContract(db as never, fresh)).toEqual({ blocked: "current_invalid" });
    expect(await db.select().from(contractCommissionRoleMaps).where(eq(contractCommissionRoleMaps.contractId, fresh))).toHaveLength(0);
    expect(readFileSync(path.resolve(__dirname, "installmentCommissions.ts"), "utf8")).toMatch(/"blocked" in resolution\) return hold\("role_map_invalid"/);
    await db.delete(commissionRoleMapVersions).where(eq(commissionRoleMapVersions.version, maxVersion + 1));
  });
});
