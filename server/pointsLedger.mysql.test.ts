import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { contracts, customers, ownershipEntitlements, pointsLedger, reservations, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Extrato de pontos (TSE #29) em MySQL real: só inclusão, saldo nunca negativo, crédito anual uma vez, estorno uma vez.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("extrato de pontos em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let userId: number;
  let entitlementId: number;
  let weekEntitlementId: number;
  let reservationId: number;
  let otherReservationId: number;
  let contractIdForRace: number;
  let resortIdForRace: number;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 6 });
    db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `points-${runId}`, name: "Atendimento pontos", role: "admin" }).$returningId();
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Associado Pontos ${runId}`, status: "active" }).$returningId();
    const [{ id: contractId }] = await db.insert(contracts).values({ number: `PTS-${runId}`, customerId, status: "active", totalAmount: "10000.00" } as never).$returningId();
    const [{ id: otherContractId }] = await db.insert(contracts).values({ number: `PTS-OUTRO-${runId}`, customerId, status: "active", totalAmount: "10000.00" } as never).$returningId();
    const [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort Pontos ${runId}` } as never).$returningId();
    const [{ id: unitId }] = await db.insert(units).values({ resortId, code: `P-${runId}` } as never).$returningId();
    contractIdForRace = contractId; resortIdForRace = resortId;
    [{ id: entitlementId }] = await db.insert(ownershipEntitlements).values({ contractId, resortId, entitlementType: "points", annualPoints: 1000, validFrom: new Date("2026-01-01T12:00:00Z"), validUntil: new Date("2035-12-31T12:00:00Z") }).$returningId();
    [{ id: weekEntitlementId }] = await db.insert(ownershipEntitlements).values({ contractId, resortId, entitlementType: "fixed_week", fixedWeek: 10 }).$returningId();
    [{ id: reservationId }] = await db.insert(reservations).values({ customerId, contractId, unitId, checkIn: new Date("2026-11-10T12:00:00Z"), checkOut: new Date("2026-11-14T12:00:00Z"), status: "confirmed" }).$returningId();
    [{ id: otherReservationId }] = await db.insert(reservations).values({ customerId, contractId: otherContractId, unitId, checkIn: new Date("2026-12-10T12:00:00Z"), checkOut: new Date("2026-12-12T12:00:00Z"), status: "confirmed" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const caller = (role = "service") => appRouter.createCaller({ user: { id: userId, role } } as never);
  const balance = async () => (await caller().pointsLedger.statement({ entitlementId })).balance;

  it("credita o ano uma vez só, dentro da vigência, e só em direito por pontos", async () => {
    await caller().pointsLedger.creditAnnual({ entitlementId, year: 2026 });
    expect(await balance()).toBe(1000);
    await expect(caller().pointsLedger.creditAnnual({ entitlementId, year: 2026 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().pointsLedger.creditAnnual({ entitlementId, year: 2040 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().pointsLedger.creditAnnual({ entitlementId: weekEntitlementId, year: 2026 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const results = await Promise.allSettled([2027, 2027, 2027].map(year => caller().pointsLedger.creditAnnual({ entitlementId, year })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await balance()).toBe(2000);
  });

  it("uso não passa do saldo, uma reserva consome uma vez, e reserva de outro contrato é recusada", async () => {
    await caller().pointsLedger.recordUsage({ entitlementId, points: 600, reservationId, note: "Semana de novembro", requestId: randomUUID() });
    expect(await balance()).toBe(1400);
    await expect(caller().pointsLedger.recordUsage({ entitlementId, points: 10, reservationId, requestId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().pointsLedger.recordUsage({ entitlementId, points: 10, reservationId: otherReservationId, requestId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().pointsLedger.recordUsage({ entitlementId, points: 1401, requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const results = await Promise.allSettled([800, 800].map(points => caller().pointsLedger.recordUsage({ entitlementId, points, requestId: randomUUID() })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await balance()).toBe(600);
  });

  it("estorno devolve uma vez, não se estorna estorno, libera a reserva para novo uso e ajuste é só do administrador", async () => {
    const statement = await caller().pointsLedger.statement({ entitlementId });
    const usage = statement.entries.find(entry => entry.entryType === "usage" && entry.reservationId === reservationId)!;
    await expect(caller("service").pointsLedger.reverse({ entryId: usage.id, note: "Reserva remarcada" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const reversal = await caller("admin").pointsLedger.reverse({ entryId: usage.id, note: "Reserva remarcada" });
    expect(await balance()).toBe(1200);
    await expect(caller("admin").pointsLedger.reverse({ entryId: usage.id, note: "De novo por engano" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller("admin").pointsLedger.reverse({ entryId: reversal.entryId, note: "Estorno do estorno" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller().pointsLedger.recordUsage({ entitlementId, points: 500, reservationId, requestId: randomUUID() });
    expect(await balance()).toBe(700);

    await expect(caller("service").pointsLedger.adjust({ entitlementId, points: 50, note: "Bônus de fidelidade", requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("admin").pointsLedger.adjust({ entitlementId, points: -701, note: "Correção maior que o saldo", requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller("admin").pointsLedger.adjust({ entitlementId, points: -200, note: "Correção de lançamento manual", requestId: randomUUID() });
    const final = await caller().pointsLedger.statement({ entitlementId });
    expect(final.balance).toBe(500);
    expect(final.entries[0]).toMatchObject({ entryType: "adjustment", points: -200, balanceAfter: 500 });
    expect(final.entries.find(entry => entry.id === usage.id)).toMatchObject({ reversed: true });
  });

  it("reenvio com o mesmo requestId devolve o mesmo lançamento e não debita de novo", async () => {
    const before = await balance();
    const requestId = randomUUID();
    const first = await caller().pointsLedger.recordUsage({ entitlementId, points: 50, requestId });
    const again = await caller().pointsLedger.recordUsage({ entitlementId, points: 50, requestId });
    expect(again.entryId).toBe(first.entryId);
    const adjustId = randomUUID();
    const adjusted = await caller("admin").pointsLedger.adjust({ entitlementId, points: 20, note: "Bônus de boas-vindas", requestId: adjustId });
    const results = await Promise.all([1, 2].map(() => caller("admin").pointsLedger.adjust({ entitlementId, points: 20, note: "Bônus de boas-vindas", requestId: adjustId })));
    expect(results.map(result => result.entryId)).toEqual([adjusted.entryId, adjusted.entryId]);
    expect(await balance()).toBe(before - 50 + 20);
  });

  it("estorno de crédito e uso ao mesmo tempo nunca deixam o saldo negativo", async () => {
    for (let round = 0; round < 10; round += 1) {
      const [{ id: racing }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 100, validFrom: new Date("2026-01-01T12:00:00Z"), validUntil: new Date("2035-12-31T12:00:00Z") }).$returningId();
      const credit = await caller().pointsLedger.creditAnnual({ entitlementId: racing, year: 2026 });
      const results = await Promise.allSettled([
        caller("admin").pointsLedger.reverse({ entryId: credit.entryId, note: "Crédito lançado por engano" }),
        caller().pointsLedger.recordUsage({ entitlementId: racing, points: 100, requestId: randomUUID() }),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect((await caller().pointsLedger.statement({ entitlementId: racing })).balance).toBe(0);
    }
  });

  it("extrato longo: saldo pela soma de todos os lançamentos e lista dos mais recentes avisando o corte", async () => {
    const [{ id: busy }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 0 }).$returningId();
    await db.insert(pointsLedger).values(Array.from({ length: 620 }, (_, index) => ({ entitlementId: busy, entryType: "adjustment" as const, points: 1, note: `Lote sintético ${index}`, createdByUserId: userId })));
    const statement = await caller().pointsLedger.statement({ entitlementId: busy });
    expect(statement.balance).toBe(620);
    expect(statement.totalEntries).toBe(620);
    expect(statement.truncated).toBe(true);
    expect(statement.entries).toHaveLength(500);
    expect(statement.entries[0]!.balanceAfter).toBe(620);
    expect(statement.entries.at(-1)!.balanceAfter).toBe(121);
  });

  it("direito de uso cancelado não recebe ajuste", async () => {
    const [{ id: closed }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 100, status: "cancelled" }).$returningId();
    await expect(caller("admin").pointsLedger.adjust({ entitlementId: closed, points: 50, note: "Bônus depois do distrato", requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
