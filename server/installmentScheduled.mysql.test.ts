import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { contracts, customers, domainEvents, installments } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { recordInstallmentsScheduled } from "./installmentScheduledFacts";

// PKG-FIN-03: `installment.scheduled` por parcela aberta ou vencida; repetir não duplica; mudar data/valor gera evento novo; paga/cancelada fica de fora.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("installment.scheduled em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
  });
  afterAll(async () => { await pool?.end(); });

  const eventsOf = async (contractId: number) => (await db.select().from(domainEvents).where(eq(domainEvents.eventName, "installment.scheduled")))
    .map(row => JSON.parse(row.payload ?? "{}") as Record<string, unknown>).filter(payload => payload.contractId === contractId);

  async function seed(label: string) {
    const [customer] = await db.insert(customers).values({ fullName: `SYN ${label} ${runId}`, email: `syn.${label}.${runId}@example.test`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `SCH-${label}-${runId}`, customerId: customer.id, status: "active", totalAmount: "4000.00" }).$returningId();
    const ids: number[] = [];
    for (const [sequence, status, dueDate] of [[1, "open", "2026-11-05"], [2, "overdue", "2026-12-05"], [3, "paid", "2027-01-05"], [4, "cancelled", "2027-02-05"]] as const) {
      const [row] = await db.insert(installments).values({ contractId: contract.id, sequence, dueDate: new Date(`${dueDate}T12:00:00Z`), amount: "1000.00", status }).$returningId();
      ids.push(row.id);
    }
    return { contractId: contract.id, customerId: customer.id, ids };
  }
  const run = (contractId: number, onlyIds?: number[]) => db.transaction(tx => recordInstallmentsScheduled(tx, { contractId, actorUserId: null, onlyIds }));

  it("avisa só as parcelas aberta e vencida, com o payload combinado, e repetir não duplica", async () => {
    const s = await seed("a");
    expect(await run(s.contractId)).toBe(2);
    expect(await run(s.contractId)).toBe(2);
    const events = await eventsOf(s.contractId);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.installmentId).sort()).toEqual([s.ids[0], s.ids[1]].sort());
    expect(events.find(e => e.sequence === 1)).toEqual({ installmentId: s.ids[0], contractId: s.contractId, customerId: s.customerId, sequence: 1, dueDate: "2026-11-05", amount: "1000.00" });
  });

  it("contrato cancelado ou encerrado não gera aviso de parcela a receber", async () => {
    const s = await seed("c");
    await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, s.contractId));
    expect(await run(s.contractId)).toBe(0);
    await db.update(contracts).set({ status: "closed" }).where(eq(contracts.id, s.contractId));
    expect(await run(s.contractId)).toBe(0);
    expect(await eventsOf(s.contractId)).toHaveLength(0);
  });

  it("parcela com recebimento parcial anuncia só o saldo; quitada pelo recebimento não gera aviso", async () => {
    const s = await seed("d");
    await db.update(installments).set({ paidAmount: "400.00" }).where(eq(installments.id, s.ids[0]));
    await db.update(installments).set({ paidAmount: "1000.00" }).where(eq(installments.id, s.ids[1]));
    expect(await run(s.contractId)).toBe(1);
    expect((await eventsOf(s.contractId)).map(e => [e.installmentId, e.amount])).toEqual([[s.ids[0], "600.00"]]);
  });

  it("voltar a um valor já usado (100 -> 110 -> 100) gera aviso novo quando a transição é outra", async () => {
    const s = await seed("e");
    await run(s.contractId, [s.ids[0]]);
    await db.update(installments).set({ amount: "1100.00" }).where(eq(installments.id, s.ids[0]));
    await db.transaction(tx => recordInstallmentsScheduled(tx, { contractId: s.contractId, actorUserId: null, onlyIds: [s.ids[0]], transition: "adj1" }));
    await db.update(installments).set({ amount: "1000.00" }).where(eq(installments.id, s.ids[0]));
    await db.transaction(tx => recordInstallmentsScheduled(tx, { contractId: s.contractId, actorUserId: null, onlyIds: [s.ids[0]], transition: "adj2" }));
    await db.transaction(tx => recordInstallmentsScheduled(tx, { contractId: s.contractId, actorUserId: null, onlyIds: [s.ids[0]], transition: "adj2" }));
    expect((await eventsOf(s.contractId)).map(e => e.amount)).toEqual(["1000.00", "1100.00", "1000.00"]);
  });

  it("mudar valor ou vencimento gera um evento novo da mesma parcela; onlyIds limita o alcance", async () => {
    const s = await seed("b");
    await run(s.contractId);
    await db.update(installments).set({ amount: "1030.30" }).where(eq(installments.id, s.ids[0]));
    expect(await run(s.contractId, [s.ids[0]])).toBe(1);
    expect(await run(s.contractId, [])).toBe(0);
    const first = (await eventsOf(s.contractId)).filter(e => e.installmentId === s.ids[0]);
    expect(first.map(e => e.amount).sort()).toEqual(["1000.00", "1030.30"]);
    expect((await eventsOf(s.contractId)).filter(e => e.installmentId === s.ids[1])).toHaveLength(1);
  });
});
