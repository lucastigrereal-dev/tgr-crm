import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Relatórios da sala em MySQL real: só admin/financeiro, sem dado pessoal na resposta, contagem do que a sala marcou.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("relatórios da sala em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let adminId: number;
  let linerId: number;
  let customerId: number;
  const previousEnv = { ...process.env };
  const caller = (role = "admin") => appRouter.createCaller({ user: { id: adminId, role } } as never);
  const room = `Sala Rel ${runId}`;
  const day = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `rel-admin-${runId}`, name: "Gerente", role: "admin" }).$returningId();
    [{ id: linerId }] = await db.insert(users).values({ openId: `rel-liner-${runId}`, name: `Consultor ${runId}`, role: "seller" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Rel ${runId}`, documentNumber: `CPF-R-${runId}`, phone: "11999990002", status: "active" }).$returningId();
    const start = new Date(), end = new Date(start.getTime() + 30 * 60000);
    await db.insert(captureRecords).values([
      { customerId, promoterId: adminId, salesRoom: room, captureLocation: "Shopping Rel", linerId, presentationStatus: "closed", commercialOutcome: "vendeu", presentationStartedAt: start, presentationEndedAt: end },
      { customerId, promoterId: adminId, salesRoom: room, captureLocation: "Shopping Rel", linerId, presentationStatus: "presented", commercialOutcome: "caiu_em_mesa", presentationStartedAt: start, presentationEndedAt: end },
      { customerId, promoterId: adminId, salesRoom: room, captureLocation: "Shopping Rel", presentationStatus: "no_tour", ntKind: "perfil" },
    ] as never);
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  it("admin vê vendas por origem e tempo médio, sem dado pessoal", async () => {
    const result = await caller("admin").captureSheet.reports.run({ from: day(-1), to: day(1), salesRoom: room });
    expect(result.fichas).toBe(3);
    expect(result.byOrigin[0]).toMatchObject({ origin: "Shopping Rel", fichas: 3, tours: 2, vendeu: 1, caiuEmMesa: 1, naoTour: 1, conversaoPct: 50 });
    expect(result.byConsultant[0]).toMatchObject({ apresentacoes: 2, comTempo: 2, mediaMin: 30 });
    const text = JSON.stringify(result);
    expect(text).not.toContain(`CPF-R-${runId}`);
    expect(text).not.toContain("11999990002");
    expect(text).not.toContain(`Casal Rel ${runId}`);
  });

  it("vendedor e recepção não abrem o relatório; período invertido é recusado", async () => {
    await expect(caller("seller").captureSheet.reports.run({ from: day(-1), to: day(1) })).rejects.toThrow();
    await expect(caller("service").captureSheet.reports.run({ from: day(-1), to: day(1) })).rejects.toThrow();
    await expect(caller("admin").captureSheet.reports.run({ from: day(1), to: day(-1) })).rejects.toThrow(/antes do início/);
  });
});
