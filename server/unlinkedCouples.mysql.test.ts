import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs, captureRecords, customers, encounterTimeRecords, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// F1.3 + F1.4 pela rota HTTP real com MySQL descartável: o casal chega no Sales sem ficha no CRM, o Sales retenta o 422 UNKNOWN_COUPLE_CODE, a recepção cria/liga a ficha
// e os tempos entram na PRÓXIMA tentativa (mesmo eventId, sem ninguém reenviar à mão). Enquanto não liga, o casal aparece no painel (nunca DEAD silencioso).
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8).toUpperCase();
const KEY = `chave-reprocesso-${runId}`;

describe.skipIf(!integrationUrl)("reprocesso dos tempos: casal chega sem ficha, ficha criada na hora, tempos entram na próxima tentativa", () => {
  let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let server: Server; let url: string; let userId = 0; let appRouter: typeof import("./routers")["appRouter"];
  const previousEnv = { ...process.env };
  const post = (payload: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(payload) });
  const caller = (role = "admin") => appRouter.createCaller({ user: { id: userId, role, name: "Teste Reprocesso" } } as never);
  const built = new Map<string, Record<string, unknown>>();
  // O Sales reenvia o MESMO corpo (mesmos horários): sem isso o hash mudaria e o replay viraria conflito.
  const timesEvent = (code: string, eventId: string) => { if (!built.has(eventId)) built.set(eventId, makeEvent(code, eventId)); return built.get(eventId)!; };
  const makeEvent = (code: string, eventId: string) => ({ eventId, eventName: "encounter.times_recorded.v1", source: "sales-command", correlationId: `corr-${eventId}`, occurredAt: new Date().toISOString(), coupleCode: code, times: { waitStartedAt: new Date(Date.now() - 600_000).toISOString(), waitEndedAt: new Date(Date.now() - 300_000).toISOString() } });
  const settle = async <T,>(read: () => Promise<T>, done: (value: T) => boolean) => { let value = await read(); for (let i = 0; i < 40 && !done(value); i++) { await new Promise(r => setTimeout(r, 50)); value = await read(); } return value; };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    const { registerEncounterTimesReceiver, ENCOUNTER_TIMES_PATH } = await import("./encounterTimesReceiver");
    const { registerUnknownCoupleWatch } = await import("./unlinkedCouples");
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 }); db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `reproc-${runId}`, name: "Teste Reprocesso", role: "admin" }).$returningId();
    const app = express(); app.use(express.json());
    // Mesma ordem do boot (server/_core/index.ts): observação antes do receptor.
    registerUnknownCoupleWatch(app, true); registerEncounterTimesReceiver(app, KEY, true);
    server = createServer(app); await new Promise<void>(resolve => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ENCOUNTER_TIMES_PATH}`;
  });
  afterAll(async () => { process.env = previousEnv; await new Promise(resolve => server?.close(resolve)); await pool?.end(); });

  it("o caso inteiro: 422 sem ficha (alerta no painel) -> ficha criada e ligada -> a mesma entrega é aceita 201 -> o alerta some", async () => {
    const code = `CP-REPROC${runId}1`; const eventId = `evt-reproc-${runId}-1`;
    // 1) O casal chegou no Sales e o CRM ainda não tem ficha: recusa de domínio que o Sales vai retentar.
    const first = await post(timesEvent(code, eventId));
    expect(first.status).toBe(422);
    expect((await first.json()).code).toBe("UNKNOWN_COUPLE_CODE");
    const waiting = await settle(() => caller().captureSheet.unlinked(), r => r.codesWithoutCapture.some(c => c.coupleCode === code));
    expect(waiting.codesWithoutCapture.find(c => c.coupleCode === code)).toMatchObject({ attempts: 1 });
    // 2) A retentativa do Sales (mesmo eventId) não duplica o alerta.
    expect((await post(timesEvent(code, eventId))).status).toBe(422);
    await new Promise(r => setTimeout(r, 200));
    expect((await caller().captureSheet.unlinked()).codesWithoutCapture.find(c => c.coupleCode === code)!.attempts).toBe(1);
    // 3) Ficha criada na hora pela recepção (sem data = passante) e ligada ao código do casal.
    const created = await caller().captures.create({ customer: { fullName: `Casal Reprocesso ${runId}`, phone: `1197${Math.floor(Math.random() * 1e7)}` }, salesRoom: `Sala Reproc ${runId}`, isPasserby: true, createOpportunity: false } as never);
    await caller().captures.checkIn({ id: created.captureId });
    const withoutCode = await caller().captureSheet.unlinked();
    expect(withoutCode.capturesWithoutCode.map(c => c.captureId)).toContain(created.captureId); // chegou e ainda não tem código: aparece no painel
    await caller().captureSheet.setCoupleCode({ captureId: created.captureId, coupleCode: code });
    // 4) Próxima tentativa do Sales, MESMO eventId e mesmo corpo: agora entra.
    const retry = await post(timesEvent(code, eventId));
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ accepted: true, replay: false, coupleCode: code });
    const [stored] = await db.select().from(encounterTimeRecords).where(eq(encounterTimeRecords.eventId, eventId));
    expect(stored!.captureId).toBe(created.captureId);
    // 5) E mais uma entrega idêntica é replay 200 (idempotente).
    expect((await post(timesEvent(code, eventId))).status).toBe(200);
    // 6) Alerta resolvido nos dois lados.
    const after = await caller().captureSheet.unlinked();
    expect(after.codesWithoutCapture.map(c => c.coupleCode)).not.toContain(code);
    expect(after.capturesWithoutCode.map(c => c.captureId)).not.toContain(created.captureId);
  });

  it("a trilha do alerta não guarda corpo do evento nem horários, só código e eventId", async () => {
    const code = `CP-REPROC${runId}2`; const eventId = `evt-reproc-${runId}-2`;
    expect((await post(timesEvent(code, eventId))).status).toBe(422);
    const rows = await settle(() => db.select().from(auditLogs).where(like(auditLogs.idempotencyKey, `%${eventId}`)), r => r.length > 0);
    expect(rows).toHaveLength(1);
    expect(`${rows[0]!.summary}${rows[0]!.entityId}${rows[0]!.idempotencyKey}`).not.toMatch(/waitStartedAt|corr-|T\d\d:\d\d/);
    expect(rows[0]!.entityId).toBe(code);
  });

  it("ficha com chegada fora da janela, anonimizada ou com código não aparece como 'sem código'", async () => {
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Janela ${runId}`, documentNumber: `DOC-REPROC-${runId}`, phone: "11977771111", status: "active" } as never).$returningId();
    const old = new Date(Date.now() - 3 * 86_400_000);
    const [{ id: oldId }] = await db.insert(captureRecords).values({ customerId, presentationStatus: "checked_in", checkedInAt: old } as never).$returningId();
    const [{ id: anonId }] = await db.insert(captureRecords).values({ customerId, presentationStatus: "checked_in", checkedInAt: new Date(), anonymizedAt: new Date() } as never).$returningId();
    const [{ id: codedId }] = await db.insert(captureRecords).values({ customerId, presentationStatus: "checked_in", checkedInAt: new Date(), coupleCode: `CP-REPROC${runId}3` } as never).$returningId();
    const ids = (await caller().captureSheet.unlinked()).capturesWithoutCode.map(c => c.captureId);
    expect(ids).not.toContain(oldId); expect(ids).not.toContain(anonId); expect(ids).not.toContain(codedId);
  });
});
