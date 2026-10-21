import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureMotives, captureRecords, customers, qualificationPolicyVersions, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-G1: política de qualificação por versão, em MySQL real. Flag desligada = comportamento antigo; ligada = versão vigente, gravada na ficha.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const params = { minManAge: 30, minRelationshipMonths: 24, minVehicleYear: 2015, minIncome: 8000, maxItemsAccepted: 1, requireCreditCard: true, requireOwnsHome: false, vehicleKinds: ["carro", "moto"] as ("carro" | "moto")[] };

describe.skipIf(!integrationUrl)("política de qualificação versionada em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let adminId: number;
  let customerId: number;
  const code = `NQV-${runId}`;
  let captureId: number;
  const previousEnv = { ...process.env };
  const caller = (role = "admin") => appRouter.createCaller({ user: { id: adminId, role } } as never);
  const sheet = () => caller().captureSheet.byCode({ code });
  const newCapture = async (extra: Partial<typeof captureRecords.$inferInsert> = {}) => (await db.insert(captureRecords).values({ customerId, salesRoom: `Sala ${runId}`, checkedInAt: new Date(Date.now() - 60_000), maleSpouse: "titular", relationshipStatus: "Casados", relationshipYears: 5, relationshipMonths: 0, vehicleKind: "moto", vehicleYear: 2022, averageIncome: "20000", hasCreditCard: true, ownsHome: false, ...extra }).$returningId())[0].id;

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    delete process.env.QUALIFICATION_POLICY_VERSIONING_ENABLED;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `nqv-${runId}`, name: "Gerente NQV", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal NQV ${runId}`, documentNumber: `CPF-NQV-${runId}`, phone: "11999990002", status: "active", birthDate: new Date("1980-01-01") }).$returningId();
    captureId = await newCapture();
    await caller().captureSheet.setCoupleCode({ captureId, coupleCode: code });
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  it("flag desligada: política antiga (moto não vale), sem versão e criar versão não muda nada", async () => {
    await caller().captureSheet.settings.policies.create({ version: `v1-${runId}`, params });
    const off = await sheet();
    expect(off.nq.criteria.find(c => c.key === "veiculo")?.status).toBe("nq");
    expect(off.nq.criteria.some(c => c.key === "casa_propria")).toBe(true);
    expect(off.nq).not.toHaveProperty("policyVersion");
  });

  it("flag ligada: a versão vigente manda (moto vale, casa própria dispensada) e carrega a versão", async () => {
    process.env.QUALIFICATION_POLICY_VERSIONING_ENABLED = "true";
    const on = await sheet();
    expect(on.nq).toMatchObject({ nqItems: 0, outcome: "qualificado", policyVersion: `v1-${runId}` });
    expect(on.nq.criteria.some(c => c.key === "casa_propria")).toBe(false);
  });

  it("sem versão vigente com a flag ligada: volta para o legado e marca a versão 'legacy'", async () => {
    await caller().captureSheet.settings.policies.retire({ version: `v1-${runId}` });
    expect(await caller().captureSheet.settings.policies.retire({ version: `v1-${runId}` })).toMatchObject({ alreadyRetired: true });
    const legacy = await sheet();
    expect(legacy.nq).toMatchObject({ policyVersion: "legacy" });
    expect(legacy.nq.criteria.find(c => c.key === "veiculo")?.status).toBe("nq");
  });

  it("vigência não retroage e a mais nova vence; nome repetido e versão reservada são recusados; só admin cria", async () => {
    const future = new Date(Date.now() + 3_600_000);
    const created = await caller().captureSheet.settings.policies.create({ version: `v2-${runId}`, params, effectiveAt: new Date(Date.now() - 86_400_000) });
    expect(created.effectiveAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(created.effectiveAt.getTime()).toBeLessThanOrEqual(Date.now());
    await caller().captureSheet.settings.policies.create({ version: `v3-${runId}`, params: { ...params, minIncome: 90000 }, effectiveAt: future });
    expect((await sheet()).nq.policyVersion).toBe(`v2-${runId}`);
    await expect(caller().captureSheet.settings.policies.create({ version: `v2-${runId}`, params })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().captureSheet.settings.policies.create({ version: "legacy", params })).rejects.toBeTruthy();
    await expect(caller().captureSheet.settings.policies.create({ version: `v4-${runId}`, params: { ...params, extra: 1 } as never })).rejects.toBeTruthy();
    await expect(caller("seller").captureSheet.settings.policies.create({ version: `v5-${runId}`, params })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "qualification_policy"), eq(auditLogs.entityId, `v2-${runId}`)));
    expect(audit.map(a => a.action)).toContain("created");
  });

  it("o NT grava a versão vigente na ficha e ela não muda quando a política muda depois", async () => {
    const motive = (await db.select().from(captureMotives).where(and(eq(captureMotives.kind, "nt_perfil"), eq(captureMotives.code, "renda"))).limit(1))[0]!;
    const nt = await newCapture();
    await caller().captureSheet.recordNt({ captureId: nt, kind: "perfil", motiveId: motive.id });
    expect((await db.select().from(captureRecords).where(eq(captureRecords.id, nt)))[0]!.nqPolicyVersion).toBe(`v2-${runId}`);
    await caller().captureSheet.settings.policies.retire({ version: `v2-${runId}` });
    expect((await db.select().from(captureRecords).where(eq(captureRecords.id, nt)))[0]!.nqPolicyVersion).toBe(`v2-${runId}`);
  });

  it("flag desligada o NT não grava versão; versão ilegível no banco é marcada :invalid e cai no legado", async () => {
    process.env.QUALIFICATION_POLICY_VERSIONING_ENABLED = "false";
    const motive = (await db.select().from(captureMotives).where(and(eq(captureMotives.kind, "nt_perfil"), eq(captureMotives.code, "renda"))).limit(1))[0]!;
    const nt = await newCapture();
    await caller().captureSheet.recordNt({ captureId: nt, kind: "perfil", motiveId: motive.id });
    expect((await db.select().from(captureRecords).where(eq(captureRecords.id, nt)))[0]!.nqPolicyVersion).toBeNull();
    process.env.QUALIFICATION_POLICY_VERSIONING_ENABLED = "true";
    await db.insert(qualificationPolicyVersions).values({ version: `bad-${runId}`, paramsJson: "{nope", effectiveAt: new Date(Date.now() + 1) });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const bad = await sheet();
    expect(bad.nq.policyVersion).toBe(`bad-${runId}:invalid`);
    expect(bad.nq.criteria.find(c => c.key === "veiculo")?.status).toBe("nq");
  });

  it("ficha terminal é lida pela versão gravada, mesmo depois de a vigente mudar (sheet e endpoint do Sales)", async () => {
    process.env.QUALIFICATION_POLICY_VERSIONING_ENABLED = "true";
    const strict = `strict-${runId}`;
    const loose = `loose-${runId}`;
    await caller().captureSheet.settings.policies.create({ version: loose, params });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const motive = (await db.select().from(captureMotives).where(and(eq(captureMotives.kind, "nt_perfil"), eq(captureMotives.code, "renda"))).limit(1))[0]!;
    const terminal = await newCapture();
    const terminalCode = `NQT-${runId}`;
    await caller().captureSheet.setCoupleCode({ captureId: terminal, coupleCode: terminalCode });
    await caller().captureSheet.recordNt({ captureId: terminal, kind: "perfil", motiveId: motive.id });
    expect((await caller().captureSheet.byCode({ code: terminalCode })).nq).toMatchObject({ policyVersion: loose, outcome: "qualificado" });
    await caller().captureSheet.settings.policies.create({ version: strict, params: { ...params, vehicleKinds: ["carro"] } });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const open = await sheet();
    expect(open.nq.policyVersion).toBe(strict);
    const after = await caller().captureSheet.byCode({ code: terminalCode });
    expect(after.nq).toMatchObject({ policyVersion: loose, outcome: "qualificado" });
    const { nqByCoupleCode } = await import("./routers/captureSheet");
    expect((await nqByCoupleCode(terminalCode))?.nq.policyVersion).toBe(loose);
    expect((await db.select().from(captureRecords).where(eq(captureRecords.id, terminal)))[0]!.nqPolicyVersion).toBe(loose);
  }, 20_000);

  it("markNoTour (caminho da sala) também grava a versão", async () => {
    process.env.QUALIFICATION_POLICY_VERSIONING_ENABLED = "true";
    const motive = (await db.select().from(captureMotives).where(and(eq(captureMotives.kind, "nt_perfil"), eq(captureMotives.code, "renda"))).limit(1))[0]!;
    const id = await newCapture();
    await caller().captures.markNoTour({ id, ntKind: "perfil", motiveId: motive.id });
    const stamped = (await db.select().from(captureRecords).where(eq(captureRecords.id, id)))[0]!;
    expect(stamped.ntKind).toBe("perfil");
    expect(stamped.nqPolicyVersion).toBe(`strict-${runId}`);
  });

  it("versão ilegível com nome de 80 caracteres: o sufixo :invalid cabe em varchar(80)", async () => {
    process.env.QUALIFICATION_POLICY_VERSIONING_ENABLED = "true";
    const longName = `L${runId}`.padEnd(80, "x");
    await db.insert(qualificationPolicyVersions).values({ version: longName, paramsJson: "{nope", effectiveAt: new Date(Date.now() + 3_600_000) });
    const id = await newCapture({ nqPolicyVersion: longName });
    const code2 = `NQL-${runId}`;
    await caller().captureSheet.setCoupleCode({ captureId: id, coupleCode: code2 });
    const out = (await caller().captureSheet.byCode({ code: code2 })).nq.policyVersion!;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith(":invalid")).toBe(true);
  });
});
