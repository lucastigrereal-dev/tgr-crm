import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { applyPersistedFlagOverrides, FLAG_ALLOWLIST, FLAG_DENYLIST, FLAG_KEYS, isAllowedFlag } from "./featureFlags";

const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe("flags da tela (allow-list e deny-list)", () => {
  it("nenhuma flag da deny-list está na allow-list (COMMISSION_V2_RELEASED, mestre, CSRF, chaves e segredos)", () => {
    for (const denied of FLAG_DENYLIST) { expect(FLAG_KEYS as readonly string[]).not.toContain(denied); expect(isAllowedFlag(denied)).toBe(false); }
    expect(isAllowedFlag("COMMISSION_V2_RELEASED")).toBe(false);
    expect(isAllowedFlag("QUALQUER_OUTRA")).toBe(false);
    expect(isAllowedFlag("toString")).toBe(false);
    expect(FLAG_DENYLIST).toContain("COMMISSION_V2_RELEASED");
  });
  it("as flags lidas no boot (receptores/jobs de _core/index.ts) estão marcadas como precisa reiniciar; as lidas a cada chamada, não", () => {
    const index = readFileSync(path.resolve(__dirname, "_core/index.ts"), "utf8");
    for (const key of FLAG_KEYS) {
      const { prop, restartRequired } = FLAG_ALLOWLIST[key];
      expect(restartRequired, key).toBe(new RegExp(`ENV\\.${prop}\\b`).test(index));
    }
  });
  it("o boot aplica as sobrescritas antes de registrar rotas e a flag mestre desligada não faz nada", async () => {
    const index = readFileSync(path.resolve(__dirname, "_core/index.ts"), "utf8");
    expect(index.indexOf("applyPersistedFlagOverrides(")).toBeGreaterThan(0);
    expect(index.indexOf("await applyPersistedFlagOverrides(")).toBeLessThan(index.indexOf("registerAttendanceGate("));
    ENV.featureFlagOverridesEnabled = false;
    expect(await applyPersistedFlagOverrides({} as never)).toBe(0);
  });
});

describe.skipIf(!integrationUrl)("tela de flags em MySQL real (0084 PROPOSTA inteira em banco descartável)", () => {
  let admin: mysql.Pool; let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let scratch = ""; let adminId = 0;
  const previousEnv = { ...process.env }; const snapshot = { master: ENV.featureFlagOverridesEnabled, catalog: ENV.officialIndicatorCatalogEnabled, recovery: ENV.recoveryEligibilityEnabled };
  const caller = async (role: "admin" | "finance" = "admin") => (await import("./routers/featureFlags")).featureFlagsRouter.createCaller({ user: { id: adminId, role } } as never);

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratch = `${database.replace(/_test$/i, "")}_ff${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["users", "audit_logs", "domain_events"]) await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const url = new URL(integrationUrl!); url.pathname = `/${scratch}`;
    process.env.DATABASE_URL = url.toString();
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 4 }); db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0084_feature_flag_overrides.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    [{ id: adminId }] = await db.insert(users).values({ openId: `ff-${runId}`, name: "Admin SYN", role: "admin" }).$returningId();
    ENV.featureFlagOverridesEnabled = true;
  });
  afterAll(async () => { ENV.featureFlagOverridesEnabled = snapshot.master; ENV.officialIndicatorCatalogEnabled = snapshot.catalog; ENV.recoveryEligibilityEnabled = snapshot.recovery; process.env = previousEnv; await pool?.end(); if (scratch) await admin?.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await admin?.end(); });

  it("liga flag lida na hora: vale já, com histórico de quem mudou e auditoria; desliga de volta", async () => {
    const api = await caller();
    ENV.officialIndicatorCatalogEnabled = false;
    const out = await api.set({ key: "OFFICIAL_INDICATOR_CATALOG_ENABLED", enabled: true });
    expect(out).toMatchObject({ restartRequired: false });
    expect(ENV.officialIndicatorCatalogEnabled).toBe(true);
    await api.set({ key: "OFFICIAL_INDICATOR_CATALOG_ENABLED", enabled: false });
    expect(ENV.officialIndicatorCatalogEnabled).toBe(false);
    const history = await api.history({ key: "OFFICIAL_INDICATOR_CATALOG_ENABLED" });
    expect(history.map(h => [h.enabled, h.createdByUserId])).toEqual([[false, adminId], [true, adminId]]);
    expect((await db.select().from(auditLogs)).filter(a => a.entityType === "feature_flag")).toHaveLength(2);
  });

  it("flag de boot: grava e marca 'precisa reiniciar', sem mudar o processo; o boot seguinte aplica a sobrescrita", async () => {
    const api = await caller();
    ENV.recoveryEligibilityEnabled = false;
    expect(await api.set({ key: "RECOVERY_ELIGIBILITY_ENABLED", enabled: true })).toMatchObject({ restartRequired: true });
    expect(ENV.recoveryEligibilityEnabled).toBe(false); // processo atual intacto
    const listed = (await api.list()).flags.find(f => f.key === "RECOVERY_ELIGIBILITY_ENABLED")!;
    expect(listed).toMatchObject({ restartRequired: true, effective: false, pendingRestart: true, override: { enabled: true } });
    expect(await applyPersistedFlagOverrides(db as never)).toBeGreaterThan(0); // "boot seguinte"
    expect(ENV.recoveryEligibilityEnabled).toBe(true);
    expect((await api.list()).flags.find(f => f.key === "RECOVERY_ELIGIBILITY_ENABLED")!.pendingRestart).toBe(false);
  });

  it("COMMISSION_V2_RELEASED, o mestre, CSRF e chaves são recusados; não-admin é recusado; mestre desligado recusa e a lista mostra desligado", async () => {
    const api = await caller();
    for (const key of ["COMMISSION_V2_RELEASED", "FEATURE_FLAG_OVERRIDES_ENABLED", "CSRF_ORIGIN_CHECK_ENABLED", "RECOVERY_INTEGRATION_KEY"]) await expect(api.set({ key, enabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(process.env.COMMISSION_V2_RELEASED).not.toBe("true");
    await expect((await caller("finance")).set({ key: "COMMISSION_ROLE_MAP_ENABLED", enabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    ENV.featureFlagOverridesEnabled = false;
    try {
      await expect(api.set({ key: "COMMISSION_ROLE_MAP_ENABLED", enabled: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect((await api.list()).overridesEnabled).toBe(false);
    } finally { ENV.featureFlagOverridesEnabled = true; }
  });

  it("(P2-1) sets concorrentes na mesma flag: o valor efetivo termina igual ao persistido mais recente que o list mostra", async () => {
    const api = await caller();
    for (let round = 0; round < 5; round++) {
      await Promise.all([true, false, true, false, true, false].map(enabled => api.set({ key: "COMMISSION_ROLE_MAP_ENABLED", enabled })));
      const listed = (await api.list()).flags.find(f => f.key === "COMMISSION_ROLE_MAP_ENABLED")!;
      expect(ENV.commissionRoleMapEnabled).toBe(listed.override!.enabled);
      expect(listed.effective).toBe(listed.override!.enabled);
    }
  });

  it("(P2-3) muito histórico de uma flag não esconde as outras (MAX por flag, sem limite combinado)", async () => {
    const api = await caller();
    await api.set({ key: "ATTENDANCE_RECEIVER_ENABLED", enabled: true });
    const rows = Array.from({ length: 6000 }, () => `('COMMISSION_ROLE_MAP_ENABLED', 1, ${adminId})`).join(",");
    await pool.query(`INSERT INTO feature_flag_overrides (flagKey, enabled, createdByUserId) VALUES ${rows}`);
    const listed = (await api.list()).flags;
    expect(listed.find(f => f.key === "ATTENDANCE_RECEIVER_ENABLED")!.override).toMatchObject({ enabled: true });
    expect(listed.find(f => f.key === "COMMISSION_ROLE_MAP_ENABLED")!.override).toMatchObject({ enabled: true });
    expect(await applyPersistedFlagOverrides(db as never)).toBeGreaterThanOrEqual(2);
  });

  it("(P2-2) leitura falhando com a mestre ligada: o list mostra 'unavailable' explícito (sem null silencioso) e o boot só avisa e mantém a ENV", async () => {
    const api = await caller();
    await pool.query("RENAME TABLE feature_flag_overrides TO feature_flag_overrides_off");
    try {
      const out = await api.list();
      expect(out).toMatchObject({ overridesEnabled: true, overridesStatus: "unavailable" });
      expect(out.flags.every(f => f.pendingRestart === null && f.override === null)).toBe(true);
      const before = ENV.recoveryEligibilityEnabled;
      expect(await applyPersistedFlagOverrides(db as never)).toBe(0);
      expect(ENV.recoveryEligibilityEnabled).toBe(before);
    } finally { await pool.query("RENAME TABLE feature_flag_overrides_off TO feature_flag_overrides"); }
    expect((await api.list()).overridesStatus).toBe("ok");
  });
});
