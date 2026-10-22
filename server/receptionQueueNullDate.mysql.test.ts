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
