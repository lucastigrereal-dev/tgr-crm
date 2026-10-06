import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, policyRegistry, resorts } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// WP11 em MySQL real (migrate do zero pelo gate): RBAC, semente idempotente, aprovação só com evidência, auditoria e terminal.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("policy registry (WP11) em MySQL real", () => {
  const previousEnv = { ...process.env };
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let policyRegistryRouter: typeof import("./routers/policyRegistry").policyRegistryRouter;
  let resortId = 0;
  const as = (role: string) => policyRegistryRouter.createCaller({ user: { id: 1, role } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ policyRegistryRouter } = await import("./routers/policyRegistry"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    const [resort] = await db.insert(resorts).values({ name: `SYN registry ${runId}`, externalKey: `SYN-REG-${runId}` }).$returningId();
    resortId = resort.id;
  });

  afterAll(async () => {
    process.env = previousEnv;
    await pool?.end();
  });

  it("only admin seeds/creates/transitions; finance reads; seller is forbidden", async () => {
    await expect(as("seller").list({ resortId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("finance").seedOpen({ resortId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("service").transition({ id: 1, to: "RETIRED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await as("finance").list({ resortId })).toEqual([]);
  });

  it("seeds the 8 open types as UNAPPROVED once (idempotent) and audits each", async () => {
    expect(await as("admin").seedOpen({ resortId })).toEqual({ created: 8, total: 8 });
    expect(await as("admin").seedOpen({ resortId })).toEqual({ created: 0, total: 8 });
    const rows = await as("finance").list({ resortId });
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map(row => row.status))).toEqual(new Set(["UNAPPROVED"]));
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "policy_registry"), eq(auditLogs.action, "created")));
    expect(audits.filter(a => rows.some(r => String(r.id) === a.entityId))).toHaveLength(8);
  });

  it("approval requires approver + receipt, is audited with both, and RETIRED is terminal", async () => {
    const [commission] = await db.select().from(policyRegistry).where(and(eq(policyRegistry.resortId, resortId), eq(policyRegistry.policyType, "commission")));
    await expect(as("admin").transition({ id: commission.id, to: "APPROVED" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await db.select().from(policyRegistry).where(eq(policyRegistry.id, commission.id)))[0].status).toBe("UNAPPROVED");

    await expect(as("admin").transition({ id: commission.id, to: "APPROVED", approver: "SYN Diretoria", receiptRef: "SYN-doc-comissao-v1" })).resolves.toEqual({ id: commission.id, status: "APPROVED" });
    const [approved] = await db.select().from(policyRegistry).where(eq(policyRegistry.id, commission.id));
    expect(approved).toMatchObject({ status: "APPROVED", approver: "SYN Diretoria", receiptRef: "SYN-doc-comissao-v1" });
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "policy_registry"), eq(auditLogs.entityId, String(commission.id)), eq(auditLogs.action, "status_changed")));
    expect(audit?.summary ?? "").toContain("SYN-doc-comissao-v1");

    await expect(as("admin").transition({ id: commission.id, to: "RETIRED" })).resolves.toMatchObject({ status: "RETIRED" });
    await expect(as("admin").transition({ id: commission.id, to: "UNAPPROVED" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("create starts as DRAFT, rejects duplicates and an inverted validity window", async () => {
    const created = await as("admin").create({ resortId, policyType: "retention", version: "SYN-v2", validFrom: "2026-11-01", validTo: "2027-10-31" });
    expect((await db.select().from(policyRegistry).where(eq(policyRegistry.id, created.id)))[0].status).toBe("DRAFT");
    await expect(as("admin").create({ resortId, policyType: "retention", version: "SYN-v2" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(as("admin").create({ resortId, policyType: "retention", version: "SYN-v3", validFrom: "2027-01-01", validTo: "2026-01-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
