import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { commercialFractionHolds, commercialFractions, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Hold vencido não bloqueia outro vendedor, e o sweep administrativo libera os vencidos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("hold expirado em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let inventoryRouter: typeof import("./routers/inventory")["inventoryRouter"];
  let adminId: number;
  let sellerA: number;
  let sellerB: number;
  let resortId: number;
  let unitId: number;
  let seq = 0;
  const previousEnv = { ...process.env };
  const as = (id: number, role: "admin" | "seller") => inventoryRouter.createCaller({ user: { id, role } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ inventoryRouter } = await import("./routers/inventory"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `exh-admin-${runId}`, name: "Admin Sintético", role: "admin" }).$returningId();
    [{ id: sellerA }] = await db.insert(users).values({ openId: `exh-a-${runId}`, name: "Vendedor A Sintético", role: "seller" }).$returningId();
    [{ id: sellerB }] = await db.insert(users).values({ openId: `exh-b-${runId}`, name: "Vendedor B Sintético", role: "seller" }).$returningId();
    [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort Hold Vencido ${runId}`, status: "active" }).$returningId();
    [{ id: unitId }] = await db.insert(units).values({ resortId, code: `U-EXH-${runId}` }).$returningId();
  });
  afterAll(async () => {
    process.env = previousEnv;
    await pool?.end();
  });

  async function newFraction() {
    seq += 1;
    const [fraction] = await db.insert(commercialFractions).values({ resortId, unitId, code: `F-EXH-${seq}-${runId}`, sequence: seq, status: "available", listPrice: "1000.00" }).$returningId();
    return fraction.id;
  }
  const fractionOf = async (id: number) => (await db.select().from(commercialFractions).where(eq(commercialFractions.id, id)))[0];
  const holdsOf = (fractionId: number) => db.select().from(commercialFractionHolds).where(eq(commercialFractionHolds.fractionId, fractionId));
  /** Vence o hold direto no banco (também a reserva espelhada na cota). */
  async function expire(fractionId: number) {
    const past = new Date(Date.now() - 60 * 60_000);
    await db.update(commercialFractionHolds).set({ expiresAt: past }).where(eq(commercialFractionHolds.fractionId, fractionId));
    await db.update(commercialFractions).set({ heldUntil: past }).where(eq(commercialFractions.id, fractionId));
  }

  it("hold ainda válido bloqueia outro vendedor (controle)", async () => {
    const fractionId = await newFraction();
    await as(sellerA, "seller").createHold({ fractionId });
    await expect(as(sellerB, "seller").createHold({ fractionId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("hold vencido não bloqueia: outro vendedor reserva, o antigo vira expired e o histórico registra", async () => {
    const fractionId = await newFraction();
    const first = await as(sellerA, "seller").createHold({ fractionId });
    await expire(fractionId);
    const second = await as(sellerB, "seller").createHold({ fractionId });
    expect(second.reused).toBe(false);
    expect(second.holdId).not.toBe(first.holdId);
    const holds = await holdsOf(fractionId);
    expect(holds.find(h => h.id === first.holdId)).toMatchObject({ status: "expired", activeKey: null, releaseReason: "TTL expirado" });
    expect(holds.find(h => h.id === second.holdId)).toMatchObject({ status: "active", heldByUserId: sellerB, activeKey: `fraction:${fractionId}` });
    expect(await fractionOf(fractionId)).toMatchObject({ status: "held" });
    expect(new Date((await fractionOf(fractionId)).heldUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it("sweepExpiredHolds (admin) libera as cotas de holds vencidos, preserva as de holds válidos e é idempotente", async () => {
    const expiredFraction = await newFraction();
    const liveFraction = await newFraction();
    const expiredHold = await as(sellerA, "seller").createHold({ fractionId: expiredFraction });
    const liveHold = await as(sellerA, "seller").createHold({ fractionId: liveFraction });
    await expire(expiredFraction);

    const outcome = await as(adminId, "admin").sweepExpiredHolds();
    expect(outcome.fractions).toContain(expiredFraction);
    expect(outcome.fractions).not.toContain(liveFraction);
    expect(await fractionOf(expiredFraction)).toMatchObject({ status: "available", currentProposalId: null, heldUntil: null });
    expect((await holdsOf(expiredFraction)).find(h => h.id === expiredHold.holdId)).toMatchObject({ status: "expired", activeKey: null });
    expect(await fractionOf(liveFraction)).toMatchObject({ status: "held" });
    expect((await holdsOf(liveFraction)).find(h => h.id === liveHold.holdId)).toMatchObject({ status: "active" });

    const again = await as(adminId, "admin").sweepExpiredHolds();
    expect(again.fractions).not.toContain(expiredFraction);
    // A cota liberada pode ser reservada por outro vendedor.
    await expect(as(sellerB, "seller").createHold({ fractionId: expiredFraction })).resolves.toMatchObject({ reused: false });
  });

  it("vendedor não executa o sweep administrativo", async () => {
    await expect(as(sellerA, "seller").sweepExpiredHolds()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
