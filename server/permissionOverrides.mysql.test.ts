import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, users } from "../drizzle/schema";
import { canAccess, canCapability, canOpenMenuPath, capabilityMatrix, EDITABLE_CAPABILITIES, FIXED_ADMIN_PATHS, INTERNAL_ROLES, menuPathRoles, sanitizePermissionOverrides, setPermissionOverrides } from "../shared/permissions";
import { syncPermissionOverrides } from "../client/src/lib/permissionOverridesSync";
import { ENV } from "./_core/env";
import { canOpenArchivedSheet } from "./captureSheetDomain";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { assertCapability } from "./routers/access";
import { applyPersistedPermissionOverrides } from "./permissionOverrides";

const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe("permissões editáveis: fallback e piso fixo (puro, servidor e navegador usam as mesmas funções)", () => {
  afterEach(() => setPermissionOverrides({}));

  it("sem sobrescrita tudo vale como hoje (fallback aos padrões) e a ficha arquivada segue admin+finance", () => {
    for (const role of INTERNAL_ROLES) {
      for (const cap of Object.keys(capabilityMatrix) as Array<keyof typeof capabilityMatrix>) expect(canCapability(role, cap)).toBe((capabilityMatrix[cap] as readonly string[]).includes(role));
      for (const p of Object.keys(menuPathRoles)) expect(canOpenMenuPath(role, p)).toBe(menuPathRoles[p]!.includes(role));
    }
    expect(["admin", "finance", "seller", "service"].map(r => canOpenArchivedSheet(r))).toEqual([true, true, false, false]);
    expect(canOpenArchivedSheet(null)).toBe(false);
    expect(canOpenArchivedSheet("user")).toBe(false);
  });

  it("capacidade editável: alarga (export.pii para seller) e estreita (ficha arquivada só admin); admin nunca sai", () => {
    setPermissionOverrides({ capabilities: { "export.pii": ["seller"], "sheet.archived.open": [] } });
    expect(canCapability("seller", "export.pii")).toBe(true);
    expect(canCapability("admin", "export.pii")).toBe(true); // admin forçado mesmo fora da lista
    expect(canCapability("finance", "export.pii")).toBe(false); // lista substitui o padrão
    expect(canOpenArchivedSheet("finance")).toBe(false);
    expect(canOpenArchivedSheet("admin")).toBe(true); // lista vazia = só admin
  });

  it("piso fixo: capacidades críticas, papel desconhecido e telas administrativas NÃO mudam", () => {
    setPermissionOverrides({ capabilities: { "sale.validate": ["seller", "service"], "contract.cancel.execute": ["seller"], "commission.pay": ["seller"], "document.sign": ["seller"], "export.pii": ["seller", "hacker", 7] }, menu: { "/equipe": ["seller"], "/auditoria": ["service"], "/financeiro": ["admin", "seller"] } });
    expect(canCapability("seller", "sale.validate")).toBe(false);
    expect(canCapability("seller", "contract.cancel.execute")).toBe(false);
    expect(canCapability("seller", "commission.pay")).toBe(false);
    expect(canCapability("seller", "document.sign")).toBe(false);
    expect(canCapability("finance", "sale.validate")).toBe(true); // padrão intacto
    expect(canOpenMenuPath("seller", "/equipe")).toBe(false);
    expect(canOpenMenuPath("service", "/auditoria")).toBe(false);
    expect(canOpenMenuPath("seller", "/financeiro")).toBe(false); // tela só estreita o padrão (admin+finance)
    expect(sanitizePermissionOverrides({ capabilities: { "export.pii": ["seller", "hacker", 7] } }).capabilities["export.pii"]).toEqual(["admin", "seller"]);
    expect(Object.keys(sanitizePermissionOverrides({ capabilities: { "sale.validate": ["seller"] }, menu: { "/equipe": ["seller"] } }).capabilities)).toEqual([]);
    for (const fixed of FIXED_ADMIN_PATHS) expect(sanitizePermissionOverrides({ menu: { [fixed]: ["seller"] } }).menu[fixed]).toBeUndefined();
    expect((EDITABLE_CAPABILITIES as readonly string[])).not.toContain("sale.validate");
  });

  it("tela: estreitar funciona, o admin continua abrindo mesmo omitido, e canAccess (áreas) não é tocado", () => {
    setPermissionOverrides({ menu: { "/ficha": ["service"], "/vouchers": [] } });
    expect(canOpenMenuPath("seller", "/ficha")).toBe(false);
    expect(canOpenMenuPath("service", "/ficha")).toBe(true);
    expect(canOpenMenuPath("admin", "/ficha/abc")).toBe(true);
    expect(canOpenMenuPath("admin", "/vouchers")).toBe(true);
    expect(canOpenMenuPath("seller", "/vouchers")).toBe(false);
    expect(canAccess("seller", "finance")).toBe(false);
  });

  it("UI: o navegador aplica a mesma sanitização (payload hostil não abre tela do piso) e desligado/sem dados volta aos padrões", () => {
    syncPermissionOverrides({ enabled: true, overrides: { capabilities: { "sale.validate": ["seller"], "export.pii": ["seller"] }, menu: { "/equipe": ["seller"], "/ficha": ["admin"] } } });
    expect(canCapability("seller", "sale.validate")).toBe(false);
    expect(canCapability("seller", "export.pii")).toBe(true);
    expect(canOpenMenuPath("seller", "/equipe")).toBe(false);
    expect(canOpenMenuPath("seller", "/ficha")).toBe(false);
    syncPermissionOverrides({ enabled: false, overrides: { capabilities: { "export.pii": ["seller"] } } });
    expect(canCapability("seller", "export.pii")).toBe(false);
    syncPermissionOverrides({ enabled: true, overrides: { capabilities: { "export.pii": ["seller"] } } });
    syncPermissionOverrides(undefined);
    expect(canCapability("seller", "export.pii")).toBe(false);
    const layout = readFileSync(path.resolve(__dirname, "../client/src/components/DashboardLayout.tsx"), "utf8");
    expect(layout.indexOf("syncPermissionOverrides(permissionOverrides.data)")).toBeGreaterThan(0);
    expect(layout.indexOf("syncPermissionOverrides(permissionOverrides.data)")).toBeLessThan(layout.indexOf("canOpenMenuPath(user?.role, item.path)"));
  });

  it("servidor: assertCapability usa a sobrescrita (export.pii para seller passa; sem ela, FORBIDDEN)", () => {
    expect(() => assertCapability("seller", "export.pii")).toThrow();
    setPermissionOverrides({ capabilities: { "export.pii": ["seller"] } });
    expect(() => assertCapability("seller", "export.pii")).not.toThrow();
  });
});

describe.skipIf(!integrationUrl)("permissões editáveis em MySQL real (0085 PROPOSTA inteira em banco descartável)", () => {
  let admin: mysql.Pool; let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let scratch = ""; let adminId = 0;
  const previousEnv = { ...process.env }; const previousFlag = ENV.permissionOverridesEnabled;
  const caller = async (role: "admin" | "finance" | "seller" = "admin") => (await import("./routers/permissionOverrides")).permissionOverridesRouter.createCaller({ user: { id: adminId, role } } as never);

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratch = `${database.replace(/_test$/i, "")}_po${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["users", "audit_logs", "domain_events"]) await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const url = new URL(integrationUrl!); url.pathname = `/${scratch}`;
    process.env.DATABASE_URL = url.toString();
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 4 }); db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0085_role_permission_overrides.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    [{ id: adminId }] = await db.insert(users).values({ openId: `po-${runId}`, name: "Admin SYN", role: "admin" }).$returningId();
    ENV.permissionOverridesEnabled = true;
  });
  afterEach(() => setPermissionOverrides({}));
  afterAll(async () => { ENV.permissionOverridesEnabled = previousFlag; setPermissionOverrides({}); process.env = previousEnv; await pool?.end(); if (scratch) await admin?.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await admin?.end(); });

  it("set grava versão saneada (admin forçado), vale NA HORA no servidor, deixa histórico e auditoria; effective devolve o mesmo", async () => {
    const api = await caller();
    expect(await api.set({ scope: "capability", key: "export.pii", roles: ["seller", "bogus"] })).toMatchObject({ roles: ["admin", "seller"] });
    expect(() => assertCapability("seller", "export.pii")).not.toThrow();
    await api.set({ scope: "capability", key: "export.pii", roles: ["finance"] });
    expect(() => assertCapability("seller", "export.pii")).toThrow();
    expect((await api.history({ scope: "capability", key: "export.pii" })).map(h => [JSON.parse(h.roles), h.createdByUserId])).toEqual([[["admin", "finance"], adminId], [["admin", "seller"], adminId]]);
    expect((await db.select().from(auditLogs)).filter(a => a.action === "permission_changed")).toHaveLength(2);
    expect((await (await caller("seller")).effective()).overrides.capabilities["export.pii"]).toEqual(["admin", "finance"]);
    const listed = await api.list();
    expect(listed.capabilities.find(c => c.key === "export.pii")).toMatchObject({ overridden: true, roles: ["admin", "finance"], defaultRoles: ["admin", "finance"] });
    expect(listed.status).toBe("ok");
  });

  it("piso: capacidade crítica, tela administrativa e chave inexistente são recusadas; não-admin recusado; flag OFF recusa e effective volta vazio", async () => {
    const api = await caller();
    for (const [scope, key] of [["capability", "sale.validate"], ["capability", "contract.cancel.execute"], ["menu", "/equipe"], ["menu", "/auditoria"], ["menu", "/nao-existe"], ["capability", "nao.existe"]] as const) await expect(api.set({ scope, key, roles: ["seller"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await caller("finance")).set({ scope: "capability", key: "export.pii", roles: ["seller"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    ENV.permissionOverridesEnabled = false;
    try {
      await expect(api.set({ scope: "capability", key: "export.pii", roles: ["seller"] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect((await api.effective()).overrides).toEqual({ capabilities: {}, menu: {} });
      expect((await api.list()).status).toBe("off");
    } finally { ENV.permissionOverridesEnabled = true; }
  });

  it("tela: estreita o padrão (nunca alarga); o boot seguinte reaplica; falha no boot mantém os padrões", async () => {
    const api = await caller();
    expect(await api.set({ scope: "menu", key: "/ficha", roles: ["seller", "finance", "service"] })).toMatchObject({ roles: ["admin", "seller", "finance", "service"] });
    await api.set({ scope: "menu", key: "/financeiro", roles: ["seller", "finance"] });
    expect(canOpenMenuPath("seller", "/financeiro")).toBe(false); // seller não estava no padrão: não entra
    setPermissionOverrides({}); // "processo novo"
    await applyPersistedPermissionOverrides(db as never);
    expect(canOpenMenuPath("finance", "/financeiro")).toBe(true);
    expect(canOpenMenuPath("seller", "/financeiro")).toBe(false);
    await pool.query("RENAME TABLE role_permission_overrides TO role_permission_overrides_off");
    try { setPermissionOverrides({}); await applyPersistedPermissionOverrides(db as never); expect(canCapability("seller", "export.pii")).toBe(false); expect((await api.list()).status).toBe("unavailable"); } finally { await pool.query("RENAME TABLE role_permission_overrides_off TO role_permission_overrides"); }
  });
});
