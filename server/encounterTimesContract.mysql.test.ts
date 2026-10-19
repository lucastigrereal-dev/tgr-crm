import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureRecords, customers, encounterTimeRecords, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Contrato encounter.times_recorded.v1 (CRM-A21 / INT-10) pela rota HTTP real com MySQL: a MESMA fixture que o Sales Command usa.
// O eventId ganha um sufixo por execução (o banco de teste pode ser reaproveitado); o resto do corpo é exatamente o da fixture.
type Case = { name: string; expect: Record<string, any>; event: Record<string, any> };
const fixture = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../docs/contracts/fixtures/encounter.times_recorded.v1.fixtures.json"), "utf8")) as {
  coupleCodeSeed: { valid: string; unknown: string }; valid: Case[]; invalid: Case[]; domainRefusals: Case[]; conflict: { basedOnValid: number; changes: { times: Record<string, unknown> } };
};
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = `chave-contrato-${runId}`;
const withRun = (event: Record<string, any>) => ({ ...event, eventId: event.eventId ? `${event.eventId}-${runId}` : event.eventId });

describe.skipIf(!integrationUrl)("contrato encounter.times_recorded.v1: fixture compartilhada pela rota HTTP em MySQL", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let server: Server;
  let url: string;
  let captureId: number;
  let customerId: number;
  let userId: number;
  const previousEnv = { ...process.env };
  const post = (payload: unknown, key: string | null = KEY) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(payload) });

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    const { registerEncounterTimesReceiver, ENCOUNTER_TIMES_PATH } = await import("./encounterTimesReceiver");
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    // Código do casal fixo da fixture: se sobrou de uma execução interrompida, limpa antes de semear.
    const leftovers = await db.select({ id: captureRecords.id, customerId: captureRecords.customerId }).from(captureRecords).where(eq(captureRecords.coupleCode, fixture.coupleCodeSeed.valid));
    for (const old of leftovers) {
      await db.delete(encounterTimeRecords).where(eq(encounterTimeRecords.captureId, old.id));
      await db.delete(captureRecords).where(eq(captureRecords.id, old.id));
    }
    [{ id: userId }] = await db.insert(users).values({ openId: `ct-user-${runId}`, name: "Gerente", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Contrato ${runId}`, documentNumber: `CPF-CT-${runId}`, phone: "11999990009", status: "active" }).$returningId();
    [{ id: captureId }] = await db.insert(captureRecords).values({ customerId, promoterId: userId, salesRoom: `Sala Contrato ${runId}`, coupleCode: fixture.coupleCodeSeed.valid } as never).$returningId();
    const app = express();
    app.use(express.json());
    registerEncounterTimesReceiver(app, KEY);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ENCOUNTER_TIMES_PATH}`;
  });
  afterAll(async () => {
    process.env = previousEnv;
    await new Promise(resolve => server?.close(resolve));
    if (db && captureId) {
      await db.delete(encounterTimeRecords).where(eq(encounterTimeRecords.captureId, captureId));
      await db.delete(captureRecords).where(eq(captureRecords.id, captureId));
      await db.delete(customers).where(eq(customers.id, customerId));
      await db.delete(users).where(eq(users.id, userId));
    }
    await pool?.end();
  });

  it("sem chave ou com chave errada: 401, antes de olhar o corpo", async () => {
    const event = withRun(fixture.valid[0]!.event);
    expect((await post(event, null)).status).toBe(401);
    expect((await post(event, "errada")).status).toBe(401);
  });

  it("todo caso inválido da fixture é 400 e não grava nada", async () => {
    for (const item of fixture.invalid) {
      const response = await post(withRun(item.event));
      expect(response.status, item.name).toBe(item.expect.status);
    }
    expect(await db.select().from(encounterTimeRecords).where(eq(encounterTimeRecords.captureId, captureId))).toHaveLength(0);
  });

  it("todo caso válido: 1ª entrega 201, reenvio idêntico 200 (replay), uma linha por eventId", async () => {
    for (const item of fixture.valid) {
      const first = await post(withRun(item.event));
      expect(first.status, `${item.name} (1ª entrega)`).toBe(item.expect.firstDelivery);
      expect(await first.json()).toMatchObject({ accepted: true, replay: false, coupleCode: fixture.coupleCodeSeed.valid });
      const again = await post(withRun(item.event));
      expect(again.status, `${item.name} (replay)`).toBe(item.expect.replay);
      expect(await again.json()).toMatchObject({ accepted: true, replay: true });
    }
    expect(await db.select().from(encounterTimeRecords).where(eq(encounterTimeRecords.captureId, captureId))).toHaveLength(fixture.valid.length);
  });

  it("mesmo eventId com conteúdo diferente: 409 EVENT_ID_CONFLICT e nada muda", async () => {
    const base = withRun(fixture.valid[fixture.conflict.basedOnValid]!.event);
    const response = await post({ ...base, times: fixture.conflict.changes.times });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ accepted: false, code: "EVENT_ID_CONFLICT" });
    expect(await db.select().from(encounterTimeRecords).where(eq(encounterTimeRecords.captureId, captureId))).toHaveLength(fixture.valid.length);
  });

  it("casal que o CRM não conhece: 422 UNKNOWN_COUPLE_CODE (não é erro de rede, não se reenvia)", async () => {
    for (const item of fixture.domainRefusals) {
      const response = await post(withRun(item.event));
      expect(response.status, item.name).toBe(item.expect.status);
      expect(await response.json()).toMatchObject({ accepted: false, code: item.expect.code });
    }
  });
});
