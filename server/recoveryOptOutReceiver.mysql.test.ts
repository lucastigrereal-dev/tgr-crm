import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, customerContactOptouts, customers, nonBuyerEligibilityState } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// C2/C3 fatia 2: receptor recovery.opted_out.v1 em MySQL real pela rota HTTP + a 0080 PROPOSTA aplicada INTEIRA (com FKs) num banco descartável próprio deste teste
// (CREATE DATABASE temporário só com as tabelas-pai), para não sujar o banco compartilhado que schemaDrift.mysql.test.ts compara com o journal.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = `chave-recovery-${runId}`;
const FK_VIOLATION = { cause: { errno: 1452 } };

describe.skipIf(!integrationUrl)("receptor de opt-out do Recovery e elegibilidade em MySQL real", () => {
  let admin: mysql.Pool;
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let scratchName: string;
  let server: Server;
  let offServer: Server;
  let url: string;
  let offUrl: string;
  let seq = 0;
  const previousEnv = { ...process.env };
  const body = (code: string, over: Record<string, unknown> = {}) => ({ eventId: `rec-${runId}-1`, coupleCode: code, optedOutAt: "2026-10-21T15:00:00.000Z", source: "recovery", ...over });
  const post = (payload: unknown, key: string | null = KEY, target = url) => fetch(target, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(payload) });
  const couple = async (patch: Record<string, unknown> = {}, customerId?: number) => {
    const n = ++seq;
    const cid = customerId ?? (await db.insert(customers).values({ fullName: `Casal OO ${n} ${runId}`, documentNumber: `CPF-OO-${n}-${runId}`, phone: `1198888${String(n).padStart(4, "0")}`, status: "active" }).$returningId())[0]!.id;
    const code = `OO-${n}-${runId}`;
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: cid, salesRoom: `Sala OO ${runId}`, coupleCode: code, presentationStatus: "closed", presentationEndedAt: new Date("2026-10-21T14:00:00Z"), ...patch } as never).$returningId();
    return { customerId: cid, captureId, code };
  };

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratchName = `${database.replace(/_test$/i, "")}_oo${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratchName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["customers", "capture_records", "audit_logs", "contracts", "opportunities", "proposals", "capture_erasure_requests"]) await admin.query(`CREATE TABLE \`${scratchName}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const scratchUrl = new URL(integrationUrl!);
    scratchUrl.pathname = `/${scratchName}`;
    process.env.DATABASE_URL = scratchUrl.toString();
    const { registerRecoveryOptOutGate, registerRecoveryOptOutReceiver, RECOVERY_OPTOUT_PATH } = await import("./recoveryOptOutReceiver");
    pool = mysql.createPool({ uri: scratchUrl.toString(), connectionLimit: 6 });
    db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0080_contact_optouts_eligibility_state.sql"), "utf8");
    expect(sql.match(/FOREIGN KEY/g)).toHaveLength(3);
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    const mount = (enabled: boolean) => { const app = express(); registerRecoveryOptOutGate(app, KEY, enabled); app.use(express.json({ limit: "12mb" })); registerRecoveryOptOutReceiver(app, KEY, enabled); const s = createServer(app); return new Promise<{ s: Server; u: string }>(resolve => s.listen(0, () => resolve({ s, u: `http://127.0.0.1:${(s.address() as AddressInfo).port}${RECOVERY_OPTOUT_PATH}` }))); };
    ({ s: server, u: url } = await mount(true));
    ({ s: offServer, u: offUrl } = await mount(false));
  });
  afterAll(async () => { process.env = previousEnv; await new Promise(resolve => server?.close(resolve)); await new Promise(resolve => offServer?.close(resolve)); await pool?.end(); if (scratchName) await admin?.query(`DROP DATABASE IF EXISTS \`${scratchName}\``); await admin?.end(); });

  it("flag desligada: 404 mesmo com a chave certa e nada é gravado; sem chave/errada 401; corpo inválido 400", async () => {
    const c = await couple();
    expect((await post(body(c.code), KEY, offUrl)).status).toBe(404);
    expect(await db.select().from(customerContactOptouts)).toHaveLength(0);
    expect((await post(body(c.code), null)).status).toBe(401);
    expect((await post(body(c.code), "errada")).status).toBe(401);
    const invalid = await post({ ...body(c.code), cpf: "123" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ accepted: false, code: "INVALID_EVENT" });
    expect(await db.select().from(customerContactOptouts)).toHaveLength(0);
  });

  it("casal desconhecido: 422 UNKNOWN_COUPLE_CODE, nada gravado", async () => {
    const response = await post(body(`NAO-EXISTE-${runId}`, { eventId: `rec-${runId}-unk` }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ accepted: false, code: "UNKNOWN_COUPLE_CODE" });
    expect(await db.select().from(customerContactOptouts)).toHaveLength(0);
  });

  it("opt-out novo: 201, uma linha por cliente com origem recovery, trilha sem PII; replay 200; mesmo eventId com outro conteúdo 409", async () => {
    const c = await couple();
    const eventId = `rec-${runId}-new`;
    const created = await post(body(c.code, { eventId }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ accepted: true, replay: false, eventId });
    const rows = await db.select().from(customerContactOptouts).where(eq(customerContactOptouts.customerId, c.customerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ coupleCode: c.code, source: "recovery", eventId });
    expect(rows[0]!.optedOutAt.toISOString()).toBe("2026-10-21T15:00:00.000Z");
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `audit:recovery-optout:${eventId}`));
    expect(audit!.summary).not.toMatch(/Casal OO|CPF|1198888/);
    expect((await post(body(c.code, { eventId }))).status).toBe(200);
    const conflict = await post(body(c.code, { eventId, optedOutAt: "2026-10-22T15:00:00.000Z" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ accepted: false, code: "EVENT_ID_CONFLICT" });
    expect(await db.select().from(customerContactOptouts).where(eq(customerContactOptouts.customerId, c.customerId))).toHaveLength(1);
  });

  it("corrida: o mesmo eventId em paralelo grava uma linha", async () => {
    const c = await couple();
    const payload = body(c.code, { eventId: `rec-${runId}-race` });
    const statuses = (await Promise.all([post(payload), post(payload), post(payload)])).map(r => r.status).sort();
    expect(statuses.filter(s => s === 201)).toHaveLength(1);
    expect(statuses.every(s => s === 201 || s === 200)).toBe(true);
    expect(await db.select().from(customerContactOptouts).where(eq(customerContactOptouts.eventId, `rec-${runId}-race`))).toHaveLength(1);
  });

  it("o opt-out vale para o CLIENTE (todas as fichas) na elegibilidade, só com readOptOut; sem ele o módulo ignora a tabela", async () => {
    const { evaluateCaptureEligibility } = await import("./nonBuyerEligibility");
    const a = await couple();
    const b = await couple({}, a.customerId);
    const other = await couple();
    expect(await evaluateCaptureEligibility(db, a.captureId, { readOptOut: true })).toMatchObject({ eligible: true });
    expect((await post(body(a.code, { eventId: `rec-${runId}-cust` }))).status).toBe(201);
    for (const id of [a.captureId, b.captureId]) {
      expect((await evaluateCaptureEligibility(db, id, { readOptOut: true }))!.reasons).toEqual(["opt_out"]);
      expect(await evaluateCaptureEligibility(db, id)).toMatchObject({ eligible: true });
    }
    expect(await evaluateCaptureEligibility(db, other.captureId, { readOptOut: true })).toMatchObject({ eligible: true });
  });

  it("0080 inteira com as FKs: filho sem pai é recusado (errno 1452) nas duas tabelas; a projeção tem uma linha por ficha e acha as fichas pelo cliente", async () => {
    await expect(db.insert(customerContactOptouts).values({ customerId: 2_000_000_000, coupleCode: "X", optedOutAt: new Date("2026-10-21T10:00:00Z"), source: "crm_staff" })).rejects.toMatchObject(FK_VIOLATION);
    await expect(db.insert(nonBuyerEligibilityState).values({ captureId: 2_000_000_000, customerId: 2_000_000_000 })).rejects.toMatchObject(FK_VIOLATION);
    const a = await couple();
    const b = await couple({}, a.customerId);
    await db.insert(nonBuyerEligibilityState).values([{ captureId: a.captureId, customerId: a.customerId }, { captureId: b.captureId, customerId: a.customerId }]);
    await expect(db.insert(nonBuyerEligibilityState).values({ captureId: a.captureId, customerId: a.customerId })).rejects.toThrow();
    const rows = await db.select().from(nonBuyerEligibilityState).where(eq(nonBuyerEligibilityState.customerId, a.customerId));
    expect(rows.map(r => r.captureId).sort()).toEqual([a.captureId, b.captureId].sort());
    expect(rows[0]).toMatchObject({ eligible: false, seq: 0 });
    // crm_staff sem eventId pode repetir (vários NULL no unique)
    await db.insert(customerContactOptouts).values([{ customerId: a.customerId, coupleCode: a.code, optedOutAt: new Date("2026-10-21T10:00:00Z"), source: "crm_staff" }, { customerId: a.customerId, coupleCode: a.code, optedOutAt: new Date("2026-10-21T11:00:00Z"), source: "owner_request" }]);
  });
});
