import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, commercialFractionHistory, commercialFractionHolds, commercialFractions, customers, domainEvents, opportunities, proposals, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-PK-11: hold vencido volta ao estoque sozinho (job), preservando histórico, com evento; hold guarda proposta e operador;
// duas sessões não reservam a mesma cota; o sweep concorrente com reservas não trava (ordem de lock igual à da reserva).
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("automação de holds de cota em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let inventoryRouter: typeof import("./routers/inventory")["inventoryRouter"];
  let sweepExpiredHolds: typeof import("./holdSweep")["sweepExpiredHolds"];
  let sellerA: number;
  let sellerB: number;
  let resortId: number;
  let unitId: number;
  let proposalId: number;
  let seq = 0;
  const previousEnv = { ...process.env };
  const as = (id: number) => inventoryRouter.createCaller({ user: { id, role: "seller" } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ inventoryRouter } = await import("./routers/inventory"));
    ({ sweepExpiredHolds } = await import("./holdSweep"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 12 });
    db = drizzle({ client: pool });
    [{ id: sellerA }] = await db.insert(users).values({ openId: `hauto-a-${runId}`, name: "Vendedor A Sintético", role: "seller" }).$returningId();
    [{ id: sellerB }] = await db.insert(users).values({ openId: `hauto-b-${runId}`, name: "Vendedor B Sintético", role: "seller" }).$returningId();
    [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort Hold Auto ${runId}`, status: "active" }).$returningId();
    [{ id: unitId }] = await db.insert(units).values({ resortId, code: `U-HAUTO-${runId}` }).$returningId();
    const [customer] = await db.insert(customers).values({ fullName: `SYN Hold ${runId}`, email: `syn.hold.${runId}@example.test`, status: "active" }).$returningId();
    const [opportunity] = await db.insert(opportunities).values({ customerId: customer.id, title: `Opp Hold ${runId}`, sellerId: sellerA } as never).$returningId();
    [{ id: proposalId }] = await db.insert(proposals).values({ opportunityId: opportunity.id, reference: `P-HAUTO-${runId}`, productDescription: "Semana fixa", totalAmount: "5000.00", downPaymentAmount: "500.00", installmentCount: 3 }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  async function newFraction() {
    seq += 1;
    const [fraction] = await db.insert(commercialFractions).values({ resortId, unitId, code: `F-HAUTO-${seq}-${runId}`, sequence: seq, status: "available", listPrice: "1000.00" }).$returningId();
    return fraction.id;
  }
  const fractionOf = async (id: number) => (await db.select().from(commercialFractions).where(eq(commercialFractions.id, id)))[0];
  const holdsOf = (fractionId: number) => db.select().from(commercialFractionHolds).where(eq(commercialFractionHolds.fractionId, fractionId));
  async function expire(fractionId: number) {
    const past = new Date(Date.now() - 60 * 60_000);
    await db.update(commercialFractionHolds).set({ expiresAt: past }).where(eq(commercialFractionHolds.fractionId, fractionId));
    await db.update(commercialFractions).set({ heldUntil: past }).where(eq(commercialFractions.id, fractionId));
  }

  it("hold guarda proposta e operador, e o job devolve a cota vencida ao estoque sem ação manual, com histórico e evento", async () => {
    const fractionId = await newFraction();
    const { holdId } = await as(sellerA).createHold({ fractionId, proposalId });
    expect(await holdsOf(fractionId)).toEqual([expect.objectContaining({ id: holdId, proposalId, heldByUserId: sellerA, status: "active" })]);
    await expire(fractionId);

    const outcome = await sweepExpiredHolds(db, { actorUserId: null });
    expect(outcome.fractions).toContain(fractionId);
    expect(await fractionOf(fractionId)).toMatchObject({ status: "available", currentProposalId: null, heldUntil: null });
    // O hold não é apagado: fica expirado, com proposta e operador.
    expect(await holdsOf(fractionId)).toEqual([expect.objectContaining({ id: holdId, status: "expired", activeKey: null, proposalId, heldByUserId: sellerA })]);
    const history = await db.select().from(commercialFractionHistory).where(eq(commercialFractionHistory.fractionId, fractionId));
    expect(history.map(row => row.reason)).toEqual(["Hold comercial criado", "Sweep de hold expirado"]);
    expect(history[1]).toMatchObject({ fromStatus: "held", toStatus: "available", proposalId, actorUserId: null });
    const events = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "commercial.fraction.status.changed"), eq(domainEvents.aggregateId, String(fractionId))));
    const released = events.find(event => JSON.parse(event.payload ?? "{}").reason === "TTL expirado");
    expect(JSON.parse(released?.payload ?? "{}")).toMatchObject({ fractionId, status: "available", holdId });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "commercial_inventory"), eq(auditLogs.action, "swept"), eq(auditLogs.entityId, "expired_holds")));
    expect(audits.some(row => (row.summary ?? "").includes("cotas liberadas"))).toBe(true);
    // Repetir não muda nada (idempotente) e outro vendedor já consegue reservar.
    expect((await sweepExpiredHolds(db, { actorUserId: null })).fractions).not.toContain(fractionId);
    await expect(as(sellerB).createHold({ fractionId })).resolves.toMatchObject({ reused: false });
  });

  it("não toca hold ativo no prazo de outro operador e não libera cota vendida ou bloqueada com hold vencido", async () => {
    const live = await newFraction();
    const sold = await newFraction();
    const blocked = await newFraction();
    const liveHold = await as(sellerB).createHold({ fractionId: live });
    await as(sellerA).createHold({ fractionId: sold });
    await as(sellerA).createHold({ fractionId: blocked });
    await expire(sold);
    await expire(blocked);
    await db.update(commercialFractions).set({ status: "sold" }).where(eq(commercialFractions.id, sold));
    await db.update(commercialFractions).set({ status: "blocked", blockedReason: "teste" }).where(eq(commercialFractions.id, blocked));

    const outcome = await sweepExpiredHolds(db, { actorUserId: null });
    expect(outcome.fractions).not.toContain(live);
    expect(outcome.fractions).not.toContain(sold);
    expect(outcome.fractions).not.toContain(blocked);
    expect(await holdsOf(live)).toEqual([expect.objectContaining({ id: liveHold.holdId, status: "active", heldByUserId: sellerB })]);
    expect(await fractionOf(live)).toMatchObject({ status: "held" });
    // Os holds vencidos da cota vendida/bloqueada fecham como expirados, mas a cota fica como está.
    expect((await holdsOf(sold))[0]).toMatchObject({ status: "expired" });
    expect(await fractionOf(sold)).toMatchObject({ status: "sold" });
    expect((await holdsOf(blocked))[0]).toMatchObject({ status: "expired" });
    expect(await fractionOf(blocked)).toMatchObject({ status: "blocked" });
  });

  it("liberar hold vencido ao mesmo tempo que o sweep roda não dá deadlock", async () => {
    for (let round = 0; round < 4; round += 1) {
      const ids: number[] = [];
      const holds: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const id = await newFraction();
        holds.push((await as(sellerA).createHold({ fractionId: id })).holdId);
        await expire(id);
        ids.push(id);
      }
      const settled = await Promise.allSettled([
        sweepExpiredHolds(db, { actorUserId: null }),
        ...holds.map(holdId => as(sellerA).releaseHold({ holdId })),
      ]);
      expect((settled.filter(item => item.status === "rejected") as PromiseRejectedResult[]).map(item => String(item.reason?.message ?? item.reason))).toEqual([]);
      for (const id of ids) expect((await fractionOf(id))?.status).toBe("available");
    }
  });

  it("duas sessões reservando a mesma cota ao mesmo tempo: só uma reserva", async () => {
    const fractionId = await newFraction();
    const results = await Promise.allSettled([as(sellerA).createHold({ fractionId }), as(sellerB).createHold({ fractionId })]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(item => item.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "CONFLICT" });
    expect((await holdsOf(fractionId)).filter(item => item.status === "active")).toHaveLength(1);
    expect(await fractionOf(fractionId)).toMatchObject({ status: "held" });
  });

  it("sweep concorrente com reservas de cotas vencidas não dá deadlock e não deixa duas reservas ativas", async () => {
    const fractions: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const id = await newFraction();
      await as(sellerA).createHold({ fractionId: id });
      await expire(id);
      fractions.push(id);
    }
    const work = [
      sweepExpiredHolds(db, { actorUserId: null }),
      sweepExpiredHolds(db, { actorUserId: null }),
      ...fractions.map(id => as(sellerB).createHold({ fractionId: id })),
    ];
    const settled = await Promise.allSettled(work);
    const failures = settled.filter(item => item.status === "rejected") as PromiseRejectedResult[];
    expect(failures.map(item => String(item.reason?.message ?? item.reason))).toEqual([]);
    for (const id of fractions) {
      expect((await holdsOf(id)).filter(item => item.status === "active")).toHaveLength(1);
      expect((await fractionOf(id))?.status).toBe("held");
    }
  });
});
