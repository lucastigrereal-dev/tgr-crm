import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Bug da homologação (16/10): ficha sem data de visita não entrava na fila da sala. Dados sintéticos, sala própria por execução.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("fila da recepção com ficha sem data de visita (MySQL real)", () => {
  let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let appRouter: typeof import("./routers")["appRouter"]; let userId = 0; let customerId = 0;
  const room = `Sala Fila ${runId}`;
  const previousEnv = { ...process.env };
  const caller = (role = "admin") => appRouter.createCaller({ user: { id: userId, role, name: "Teste Fila" } } as never);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const queueIds = async (role = "service") => (await caller(role).captures.receptionQueue({ date: today, salesRoom: room })).map(row => row.capture.id);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 }); db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `fila-${runId}`, name: "Teste Fila", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Fila ${runId}`, documentNumber: `DOC-FILA-${runId}`, phone: "11977776666", city: "Natal", status: "active" } as never).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  it("(a) ficha criada pela rota SEM data de visita grava captured/scheduledAt nulo (passante) e aparece na fila de hoje; campo segue opcional", async () => {
    const created = await caller("admin").captures.create({ customerId, salesRoom: room, createOpportunity: false } as never);
    const id = (created as { captureId?: number; id?: number }).captureId ?? (created as { id: number }).id;
    const [row] = await db.select().from(captureRecords).where(eq(captureRecords.id, id));
    expect(row!.scheduledAt).toBeNull();
    expect(row!.presentationStatus).toBe("captured");
    expect(await queueIds()).toContain(id);
  });

  it("(b) ficha ANTIGA com scheduledAt nulo (e ainda 'captured') criada hoje aparece; criada em outro dia não; encerrada só com includeCompleted", async () => {
    const start = new Date(`${today}T12:00:00-03:00`);
    const [{ id: nullToday }] = await db.insert(captureRecords).values({ customerId, salesRoom: room, coupleCode: `FILA-NULL-${runId}`, scheduledAt: null, presentationStatus: "captured", createdAt: start } as never).$returningId();
    const [{ id: nullOtherDay }] = await db.insert(captureRecords).values({ customerId, salesRoom: room, coupleCode: `FILA-OUTRO-${runId}`, scheduledAt: null, presentationStatus: "captured", createdAt: new Date(start.getTime() - 3 * 86_400_000) } as never).$returningId();
    const [{ id: nullClosed }] = await db.insert(captureRecords).values({ customerId, salesRoom: room, coupleCode: `FILA-FECH-${runId}`, scheduledAt: null, presentationStatus: "closed", createdAt: start } as never).$returningId();
    const ids = await queueIds();
    expect(ids).toContain(nullToday);
    expect(ids).not.toContain(nullOtherDay);
    expect(ids).not.toContain(nullClosed);
    const all = (await caller("service").captures.receptionQueue({ date: today, salesRoom: room, includeCompleted: true })).map(row => row.capture.id);
    expect(all).toContain(nullClosed);
  });

  it("ficha com data de visita em outro dia continua fora da fila de hoje (comportamento anterior)", async () => {
    const [{ id }] = await db.insert(captureRecords).values({ customerId, salesRoom: room, coupleCode: `FILA-DATA-${runId}`, scheduledAt: new Date(Date.now() + 5 * 86_400_000), presentationStatus: "scheduled" } as never).$returningId();
    expect(await queueIds()).not.toContain(id);
  });
});

// F1.6: a lacuna que o #117 (indicadores) deixou na ENTRADA da ficha. Com CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY ligada, a recepção informa a data OU marca passante.
describe.skipIf(!integrationUrl)("F1.6: data da visita ou passante explícito na criação da ficha (MySQL real)", () => {
  let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let appRouter: typeof import("./routers")["appRouter"]; let userId = 0;
  const room = `Sala Passante ${runId}`;
  const previousEnv = { ...process.env };
  const caller = () => appRouter.createCaller({ user: { id: userId, role: "admin", name: "Teste Passante" } } as never);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const person = (label: string) => ({ fullName: `Casal ${label} ${runId}`, phone: `1196${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}` });

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 }); db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `passante-${runId}`, name: "Teste Passante", role: "admin" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  it("regra LIGADA: sem data e sem passante é recusada, e nada é gravado", async () => {
    process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY = "true";
    const customer = person("Recusa");
    await expect(caller().captures.create({ customer, salesRoom: room, createOpportunity: false } as never)).rejects.toThrow(/data da visita|passante/i);
    expect(await db.select().from(customers).where(eq(customers.phone, customer.phone))).toHaveLength(0);
    expect(await caller().captures.visitRule()).toEqual({ requireDateOrPasserby: true });
  });

  it("regra LIGADA: passante explícito entra na fila de hoje, guardado como passante e sem horário de agendamento", async () => {
    process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY = "true";
    const created = await caller().captures.create({ customer: person("Passante"), salesRoom: room, isPasserby: true, createOpportunity: false } as never);
    const [row] = await db.select().from(captureRecords).where(eq(captureRecords.id, created.captureId));
    expect(row!.isPasserby).toBe(true);
    expect(row!.scheduledAt).toBeNull();
    const queue = await caller().captures.receptionQueue({ date: today, salesRoom: room });
    expect(queue.map(item => item.capture.id)).toContain(created.captureId);
  });

  it("regra LIGADA: com data de visita passa sem precisar de passante", async () => {
    process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY = "true";
    const created = await caller().captures.create({ customer: person("Agendado"), salesRoom: room, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), createOpportunity: false } as never);
    const [row] = await db.select().from(captureRecords).where(eq(captureRecords.id, created.captureId));
    expect(row!.isPasserby).toBe(false);
    expect(row!.scheduledAt).not.toBeNull();
  });

  it("regra DESLIGADA (padrão): o comportamento anterior continua, ficha sem data é aceita", async () => {
    delete process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY;
    const created = await caller().captures.create({ customer: person("Livre"), salesRoom: room, createOpportunity: false } as never);
    expect(created.captureId).toBeGreaterThan(0);
    expect(await caller().captures.visitRule()).toEqual({ requireDateOrPasserby: false });
  });
});
