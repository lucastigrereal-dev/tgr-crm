import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, contracts, customerContactOptouts, customers, domainEvents, nonBuyerEligibilityState, opportunities } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// C2/C3 fatia 3: projeção + FOR UPDATE + reavaliação por ficha/cliente + reconciliação, em MySQL real. A 0080 PROPOSTA é aplicada INTEIRA num banco descartável próprio
// (CREATE DATABASE temporário só com as tabelas-pai, dropado no fim), sem sujar o banco compartilhado do schemaDrift.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("elegibilidade de não-comprador: projeção, reavaliação e reconciliação em MySQL real", () => {
  let admin: mysql.Pool;
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let scratchName: string;
  let svc: typeof import("./nonBuyerEligibilityService");
  let seq = 0;
  const previousEnv = { ...process.env };

  const couple = async (patch: Record<string, unknown> = {}, customerId?: number) => {
    const n = ++seq;
    const cid = customerId ?? (await db.insert(customers).values({ fullName: `Casal SV ${n} ${runId}`, documentNumber: `CPF-SV-${n}-${runId}`, phone: `1197777${String(n).padStart(4, "0")}`, status: "active" }).$returningId())[0]!.id;
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: cid, salesRoom: `Sala SV ${runId}`, coupleCode: `SV-${n}-${runId}`, presentationStatus: "closed", presentationEndedAt: new Date("2026-10-21T14:00:00Z"), ...patch } as never).$returningId();
    await db.insert(opportunities).values({ customerId: cid, title: `Op SV ${n}`, stage: "qualified" } as never);
    return { customerId: cid, captureId, code: `SV-${n}-${runId}` };
  };
  const reevaluate = (captureId: number) => db.transaction(tx => svc.reevaluateCapture(tx, captureId));
  const eventsOf = async (captureId: number) => (await db.select().from(domainEvents).where(and(eq(domainEvents.aggregateType, "capture"), eq(domainEvents.aggregateId, String(captureId)), like(domainEvents.eventName, "non_buyer.%")))).sort((a, b) => a.id - b.id);
  const stateOf = async (captureId: number) => (await db.select().from(nonBuyerEligibilityState).where(eq(nonBuyerEligibilityState.captureId, captureId)))[0];

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratchName = `${database.replace(/_test$/i, "")}_sv${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratchName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["customers", "capture_records", "domain_events", "contracts", "opportunities", "proposals", "capture_erasure_requests"]) await admin.query(`CREATE TABLE \`${scratchName}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const scratchUrl = new URL(integrationUrl!);
    scratchUrl.pathname = `/${scratchName}`;
    process.env.DATABASE_URL = scratchUrl.toString();
    pool = mysql.createPool({ uri: scratchUrl.toString(), connectionLimit: 12 });
    db = drizzle({ client: pool });
    // opt-out e projeção vêm da proposta 0080 inteira (com FKs); customer_contact_optouts/non_buyer_eligibility_state dependem só de customers/capture_records
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0080_contact_optouts_eligibility_state.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    svc = await import("./nonBuyerEligibilityService");
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); if (scratchName) await admin?.query(`DROP DATABASE IF EXISTS \`${scratchName}\``); await admin?.end(); });

  it("primeira avaliação: elegível = estado seq 1 + UM evento interno sem PII; reavaliar sem mudança não emite nada; inelegível na primeira vez cria o estado e NÃO emite", async () => {
    const c = await couple();
    expect(await reevaluate(c.captureId)).toMatchObject({ changed: true, eligible: true, seq: 1, eventId: `crm-nb-${c.captureId}-eligible-1` });
    expect(await reevaluate(c.captureId)).toMatchObject({ changed: false, eligible: true, seq: 1, eventId: null });
    const events = await eventsOf(c.captureId);
    expect(events.map(e => e.eventName)).toEqual(["non_buyer.eligible"]);
    expect(events[0]!.idempotencyKey).toBe(`crm-nb-${c.captureId}-eligible-1`);
    expect(events[0]!.payload).not.toMatch(/Casal SV|CPF|1197777|SV-\d/);
    expect(JSON.parse(events[0]!.payload!)).toEqual({ eventId: `crm-nb-${c.captureId}-eligible-1`, captureId: c.captureId, customerId: c.customerId, seq: 1, branch: "closed" });
    const open = await couple({ presentationStatus: "presented", presentationEndedAt: null });
    expect(await reevaluate(open.captureId)).toMatchObject({ changed: false, eligible: false, seq: 0 });
    expect(await stateOf(open.captureId)).toMatchObject({ eligible: false, seq: 0 });
    expect(await eventsOf(open.captureId)).toHaveLength(0);
  });

  it("cada transição emite exatamente um evento, com seq crescente: contrato revoga, distrato volta, opt-out revoga, anonimização tem prioridade", async () => {
    const c = await couple();
    await reevaluate(c.captureId); // eligible 1
    const [{ id: contractId }] = await db.insert(contracts).values({ number: `SV-${c.captureId}-${runId}`, customerId: c.customerId, usageModel: "fixed_week", status: "active", totalAmount: "1000.00" } as never).$returningId();
    expect(await reevaluate(c.captureId)).toMatchObject({ changed: true, eligible: false, seq: 2, eventId: `crm-nb-${c.captureId}-revoked-2` });
    await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, contractId));
    expect(await reevaluate(c.captureId)).toMatchObject({ changed: true, eligible: true, seq: 3, eventId: `crm-nb-${c.captureId}-eligible-3` });
    await db.insert(customerContactOptouts).values({ customerId: c.customerId, coupleCode: c.code, optedOutAt: new Date("2026-10-21T16:00:00Z"), source: "recovery", eventId: `oo-${c.captureId}-${runId}` });
    expect(await reevaluate(c.captureId)).toMatchObject({ changed: true, eligible: false, seq: 4 });
    await db.update(customers).set({ anonymizedAt: new Date("2026-10-21T17:00:00Z") }).where(eq(customers.id, c.customerId));
    expect(await reevaluate(c.captureId)).toMatchObject({ changed: false, seq: 4 }); // continua inelegível: sem evento novo
    const events = await eventsOf(c.captureId);
    expect(events.map(e => [e.eventName, JSON.parse(e.payload!).seq, JSON.parse(e.payload!).reason ?? null])).toEqual([
      ["non_buyer.eligible", 1, null], ["non_buyer.eligibility_revoked", 2, "sale_in_progress"], ["non_buyer.eligible", 3, null], ["non_buyer.eligibility_revoked", 4, "opt_out"],
    ]);
    expect(events.map(e => e.idempotencyKey)).toEqual([1, 2, 3, 4].map(n => `crm-nb-${c.captureId}-${n % 2 ? "eligible" : "revoked"}-${n}`));
  });

  it("disparo por CLIENTE (contrato/proposta/oportunidade só conhecem o cliente): reavalia todas as fichas dele, em ordem crescente", async () => {
    const a = await couple();
    const b = await couple({}, a.customerId);
    const other = await couple();
    await db.transaction(async tx => { await svc.reevaluateCustomer(tx, a.customerId); });
    expect((await stateOf(a.captureId))!.eligible && (await stateOf(b.captureId))!.eligible).toBe(true);
    expect(await stateOf(other.captureId)).toBeUndefined();
    await db.insert(contracts).values({ number: `SV-C-${a.captureId}-${runId}`, customerId: a.customerId, usageModel: "fixed_week", status: "draft", totalAmount: "1000.00" } as never);
    const results = await db.transaction(tx => svc.reevaluateCustomer(tx, a.customerId));
    expect(results.map(r => [r.captureId, r.eligible, r.seq])).toEqual([[a.captureId, false, 2], [b.captureId, false, 2]]);
    expect(await svc.reevaluateIfEnabled({} as never, { customerId: a.customerId }, false)).toEqual([]);
  });

  it("corrida: duas transações reavaliando a mesma ficha geram UM evento e seq 1 (o FOR UPDATE serializa); reavaliações concorrentes por cliente não dão deadlock", async () => {
    const c = await couple();
    const runs = await Promise.all([reevaluate(c.captureId), reevaluate(c.captureId), reevaluate(c.captureId), reevaluate(c.captureId)]);
    expect(runs.filter(r => r!.changed)).toHaveLength(1);
    expect(await eventsOf(c.captureId)).toHaveLength(1);
    expect(await stateOf(c.captureId)).toMatchObject({ eligible: true, seq: 1 });

    const a = await couple();
    const b = await couple({}, a.customerId);
    const d = await couple({}, a.customerId);
    const customerRuns = await Promise.all(Array.from({ length: 6 }, (_, i) => db.transaction(async tx => i % 2 ? svc.reevaluateCustomer(tx, a.customerId) : svc.reevaluateCapture(tx, [a.captureId, b.captureId, d.captureId][i % 3]!))));
    expect(customerRuns).toHaveLength(6);
    for (const id of [a.captureId, b.captureId, d.captureId]) { expect(await eventsOf(id)).toHaveLength(1); expect(await stateOf(id)).toMatchObject({ eligible: true, seq: 1 }); }
  });

  it("reconciliação converge SEM nenhum gancho, é idempotente e pagina; só varre candidatas (encerrada/não-tour ou já elegível)", async () => {
    for (const table of ["customer_contact_optouts", "non_buyer_eligibility_state", "domain_events", "contracts", "opportunities", "proposals", "capture_erasure_requests", "capture_records", "customers"]) await pool.query(`DELETE FROM ${table}`);
    const eligibleA = await couple();
    const eligibleB = await couple();
    const withContract = await couple();
    const notFinished = await couple({ presentationStatus: "captured", presentationEndedAt: null });
    await db.insert(contracts).values({ number: `SV-R-${withContract.captureId}-${runId}`, customerId: withContract.customerId, usageModel: "fixed_week", status: "active", totalAmount: "1000.00" } as never);
    const first = await svc.reconcileAllNonBuyerEligibility(db, { batchSize: 2 });
    expect(first).toMatchObject({ scanned: 3, changed: 2, eligible: 2, revoked: 0 }); // notFinished não é candidata; withContract avaliada e inelegível desde o início (sem evento)
    expect(await stateOf(notFinished.captureId)).toBeUndefined();
    expect((await stateOf(withContract.captureId))).toMatchObject({ eligible: false, seq: 0 });
    // sem passar por gancho nenhum, o mundo muda: A compra, B faz opt-out, a ficha em aberto encerra
    await db.insert(contracts).values({ number: `SV-R2-${eligibleA.captureId}-${runId}`, customerId: eligibleA.customerId, usageModel: "fixed_week", status: "pending_signature", totalAmount: "1000.00" } as never);
    await db.insert(customerContactOptouts).values({ customerId: eligibleB.customerId, coupleCode: eligibleB.code, optedOutAt: new Date("2026-10-21T16:00:00Z"), source: "recovery", eventId: `oo-r-${runId}` });
    await db.update(captureRecords).set({ presentationStatus: "closed", presentationEndedAt: new Date("2026-10-21T18:00:00Z") }).where(eq(captureRecords.id, notFinished.captureId));
    const second = await svc.reconcileAllNonBuyerEligibility(db, { batchSize: 3 });
    expect(second).toMatchObject({ changed: 3, eligible: 1, revoked: 2 });
    const third = await svc.reconcileAllNonBuyerEligibility(db);
    expect(third).toMatchObject({ changed: 0, eligible: 0, revoked: 0 });
    expect(await stateOf(eligibleA.captureId)).toMatchObject({ eligible: false, seq: 2, lastReason: "sale_in_progress" });
    expect(await stateOf(eligibleB.captureId)).toMatchObject({ eligible: false, seq: 2, lastReason: "opt_out" });
    expect(await stateOf(notFinished.captureId)).toMatchObject({ eligible: true, seq: 1 });
    const all = await db.select().from(domainEvents).where(like(domainEvents.eventName, "non_buyer.%"));
    expect(all).toHaveLength(2 + 3); // 2 elegíveis iniciais + 3 transições; nenhuma duplicata
    expect(new Set(all.map(e => e.idempotencyKey)).size).toBe(all.length);
  });
});
