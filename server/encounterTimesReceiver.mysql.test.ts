import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, customers, encounterTimeRecords, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Receptor encounter.times_recorded.v1 em MySQL real, pela rota HTTP: eventId único, replay, conflito, casal desconhecido, só adiciona.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = `chave-teste-${runId}`;

describe.skipIf(!integrationUrl)("receptor de tempos de sala em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let server: Server;
  let url: string;
  let captureId: number;
  const previousEnv = { ...process.env };
  const coupleCode = `TGR-ET-${runId}`;
  const body = (extra: Record<string, unknown> = {}) => ({
    eventId: `evt-${runId}-1`, eventName: "encounter.times_recorded.v1", source: "sales-command", correlationId: `corr-${runId}`, occurredAt: "2026-10-17T15:00:00Z", coupleCode,
    times: { waitStartedAt: "2026-10-17T14:00:00Z", waitEndedAt: "2026-10-17T14:10:00Z", consultantStartedAt: "2026-10-17T14:10:00Z", consultantEndedAt: "2026-10-17T14:50:00Z" }, ...extra,
  });
  const post = (payload: unknown, key: string | null = KEY) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(payload) });

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    const { registerEncounterTimesReceiver, ENCOUNTER_TIMES_PATH } = await import("./encounterTimesReceiver");
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    const [{ id: userId }] = await db.insert(users).values({ openId: `et-user-${runId}`, name: "Gerente", role: "admin" }).$returningId();
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal ET ${runId}`, documentNumber: `CPF-ET-${runId}`, phone: "11999990003", status: "active" }).$returningId();
    [{ id: captureId }] = await db.insert(captureRecords).values({ customerId, promoterId: userId, salesRoom: `Sala ET ${runId}`, coupleCode } as never).$returningId();
    const app = express();
    app.use(express.json());
    registerEncounterTimesReceiver(app, KEY, true);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ENCOUNTER_TIMES_PATH}`;
  });
  afterAll(async () => { process.env = previousEnv; await new Promise(resolve => server?.close(resolve)); await pool?.end(); });

  it("sem chave ou com chave errada: 401; corpo inválido: 400", async () => {
    expect((await post(body(), null)).status).toBe(401);
    expect((await post(body(), "errada")).status).toBe(401);
    expect((await post({ ...body(), extra: 1 })).status).toBe(400);
  });

  it("grava uma linha por eventId, com trilha, e não altera a ficha", async () => {
    const before = (await db.select().from(captureRecords).where(eq(captureRecords.id, captureId)))[0]!;
    const response = await post(body());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ accepted: true, replay: false, coupleCode });
    const rows = await db.select().from(encounterTimeRecords).where(eq(encounterTimeRecords.captureId, captureId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: `evt-${runId}-1`, consultantDispensed: false });
    expect(rows[0]!.consultantEndedAt?.toISOString()).toBe("2026-10-17T14:50:00.000Z");
    expect(rows[0]!.closerStartedAt).toBeNull();
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `audit:encounter-times:evt-${runId}-1`));
    expect(audit).toHaveLength(1);
    expect(await db.select().from(captureRecords).where(eq(captureRecords.id, captureId))).toEqual([before]);
  });

  it("reenvio idêntico é replay 200; mesmo eventId com outro conteúdo é 409; nada duplica", async () => {
    expect((await post(body())).status).toBe(200);
    const conflict = await post(body({ times: { endedAt: "2026-10-17T16:00:00Z" } }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ accepted: false, code: "EVENT_ID_CONFLICT" });
    expect(await db.select().from(encounterTimeRecords).where(eq(encounterTimeRecords.captureId, captureId))).toHaveLength(1);
  });

  it("evento novo do mesmo casal vira outra linha (correção); casal desconhecido é 422", async () => {
    expect((await post(body({ eventId: `evt-${runId}-2`, occurredAt: "2026-10-17T16:00:00Z", times: { closerStartedAt: "2026-10-17T14:50:00Z", closerEndedAt: "2026-10-17T15:30:00Z", endedAt: "2026-10-17T15:30:00Z" } }))).status).toBe(201);
    expect(await db.select().from(encounterTimeRecords).where(eq(encounterTimeRecords.captureId, captureId))).toHaveLength(2);
    const unknown = await post(body({ eventId: `evt-${runId}-3`, coupleCode: `NAO-EXISTE-${runId}` }));
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ accepted: false, code: "UNKNOWN_COUPLE_CODE" });
  });

  it("corrida: o mesmo eventId em paralelo grava só uma linha", async () => {
    const payload = body({ eventId: `evt-${runId}-race` });
    const statuses = (await Promise.all([post(payload), post(payload), post(payload)])).map(r => r.status).sort();
    expect(statuses.filter(s => s === 201)).toHaveLength(1);
    expect(statuses.every(s => s === 201 || s === 200)).toBe(true);
    expect(await db.select().from(encounterTimeRecords).where(eq(encounterTimeRecords.eventId, `evt-${runId}-race`))).toHaveLength(1);
  });
});
