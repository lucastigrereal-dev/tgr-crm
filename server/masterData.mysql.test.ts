import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, masterDataOptions, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Dicionários de cadastro (TSE #25) em MySQL real: lista vazia deixa o campo livre; com opções, a captação só aceita a lista.
// Nenhum outro teste MySQL grava estes campos pela captação; tudo o que este teste ativa é desativado no fim.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("dicionários de cadastro em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let adminId: number;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `masterdata-${runId}`, name: "Admin dicionários", role: "admin" }).$returningId();
  });
  afterAll(async () => {
    for (const field of ["partnerProfession", "captureLocation", "transportation"] as const) await db?.update(masterDataOptions).set({ active: false }).where(eq(masterDataOptions.field, field));
    process.env = previousEnv;
    await pool?.end();
  });

  const caller = (role = "admin") => appRouter.createCaller({ user: { id: adminId, role } } as never);
  const capture = (partnerProfession: string, suffix: string) => caller("seller").captures.create({ customer: { fullName: `Casal Sintético ${runId} ${suffix}`, phone: `8490${runId.replace(/\D/g, "").padEnd(4, "0").slice(0, 4)}${suffix.padStart(3, "0")}`, city: "Natal", state: "RN" }, partnerProfession, createOpportunity: false });
  const savedProfession = async (captureId: number) => (await db.select({ value: captureRecords.partnerProfession }).from(captureRecords).where(eq(captureRecords.id, captureId)))[0]!.value;

  it("sem opção ativa o campo é livre; com lista, grava a grafia da lista e recusa valor fora dela", async () => {
    await db.update(masterDataOptions).set({ active: false }).where(eq(masterDataOptions.field, "partnerProfession"));
    const free = await capture(`Ofício livre ${runId}`, "1");
    expect(await savedProfession(free.captureId)).toBe(`Ofício livre ${runId}`);

    await caller().masterData.add({ field: "partnerProfession", value: `Médica ${runId}` });
    const canonical = await capture(`  medica   ${runId.toUpperCase()} `, "2");
    expect(await savedProfession(canonical.captureId)).toBe(`Médica ${runId}`);
    await expect(capture(`Astronauta ${runId}`, "3")).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("não está na lista") });
  });

  it("não duplica opção, reativa a desativada e só o administrador mexe na lista", async () => {
    await expect(caller().masterData.add({ field: "partnerProfession", value: `MEDICA ${runId}` })).rejects.toMatchObject({ code: "CONFLICT" });
    const [option] = await db.select().from(masterDataOptions).where(like(masterDataOptions.value, `Médica ${runId}`));
    await caller().masterData.setActive({ id: option!.id, active: false });
    const again = await caller().masterData.add({ field: "partnerProfession", value: `Médica  ${runId}` });
    expect(again).toEqual({ id: option!.id, reactivated: true });
    await expect(caller("seller").masterData.add({ field: "partnerProfession", value: `Outra ${runId}` })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("seller").masterData.setActive({ id: option!.id, active: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cria a lista a partir das fichas juntando grafias diferentes, e a cobertura aponta o que ficou fora", async () => {
    await db.update(masterDataOptions).set({ active: false }).where(eq(masterDataOptions.field, "partnerProfession"));
    const spellings = [`Engenheiro ${runId}`, `engenheiro ${runId}`, `ENGENHEIRO ${runId}`, `Advogada ${runId}`];
    for (const [index, value] of spellings.entries()) await capture(value, String(10 + index));
    const imported = await caller().masterData.importExisting({ field: "partnerProfession" });
    expect(imported.added).toBeGreaterThanOrEqual(2);
    const options = (await caller().masterData.list({ field: "partnerProfession" })).filter(row => row.value.includes(runId));
    expect(options.filter(row => row.value.toLowerCase().startsWith("engenheiro"))).toHaveLength(1);
    expect(options.map(row => row.value)).toContain(`Advogada ${runId}`);

    const advogada = options.find(row => row.value === `Advogada ${runId}`)!;
    await caller().masterData.setActive({ id: advogada.id, active: false });
    const coverage = await caller().masterData.coverage({ field: "partnerProfession" });
    expect(coverage.outside).toContainEqual({ value: `Advogada ${runId}`, total: 1 });
  });

  it("valor gravado pelo sistema (Sales Command) vale com a lista fechada e não entra na cobertura nem na importação", async () => {
    await caller().masterData.add({ field: "captureLocation", value: `Praia ${runId}` });
    const automatic = await caller("seller").captures.create({ customer: { fullName: `Casal Automático ${runId}`, city: "Natal", state: "RN" }, captureLocation: "sales command", createOpportunity: false });
    expect((await db.select({ value: captureRecords.captureLocation }).from(captureRecords).where(eq(captureRecords.id, automatic.captureId)))[0]!.value).toBe("sales command");
    expect((await caller().masterData.coverage({ field: "captureLocation" })).outside.map(row => row.value.toLowerCase())).not.toContain("sales command");
    await caller().masterData.importExisting({ field: "captureLocation" });
    expect((await caller().masterData.list({ field: "captureLocation", includeInactive: true })).map(row => row.value.toLowerCase())).not.toContain("sales command");
  });

  it("a lista ativa de um campo tem teto: incluir, reativar ou importar além dele é recusado", async () => {
    await db.update(masterDataOptions).set({ active: false }).where(eq(masterDataOptions.field, "transportation"));
    const rows = Array.from({ length: 2000 }, (_, index) => ({ field: "transportation" as const, value: `Teto ${runId} ${index}`, normalizedKey: `teto ${runId} ${index}` }));
    for (let start = 0; start < rows.length; start += 500) await db.insert(masterDataOptions).values(rows.slice(start, start + 500));
    expect((await caller().masterData.list({ field: "transportation" })).filter(row => row.value.startsWith(`Teto ${runId}`))).toHaveLength(2000);
    await expect(caller().masterData.add({ field: "transportation", value: `Excedente ${runId}` })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [first] = await db.select().from(masterDataOptions).where(eq(masterDataOptions.normalizedKey, `teto ${runId} 0`));
    await caller().masterData.setActive({ id: first!.id, active: false });
    await caller().masterData.add({ field: "transportation", value: `Excedente ${runId}` });
    await expect(caller().masterData.setActive({ id: first!.id, active: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await db.update(masterDataOptions).set({ active: false }).where(eq(masterDataOptions.field, "transportation"));
  });
});
