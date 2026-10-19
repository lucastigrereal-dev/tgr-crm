import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// INT-13 (lado CRM), prova em tempo de execução: depois de receber um evento de outro sistema, a ÚNICA diferença no banco inteiro são as
// tabelas que o receptor declara como suas. Compara a contagem de linhas de TODAS as tabelas antes e depois. Dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = `chave-owner-${runId}`;

describe.skipIf(!integrationUrl)("INT-13 CRM: receptor de tempos de sala só escreve no que é do CRM (MySQL real)", () => {
  let pool: mysql.Pool;
  let admin: mysql.Connection;
  let cloneName = "";
  let server: Server;
  let url: string;
  const previousEnv = { ...process.env };
  const coupleCode = `TGR-OW-${runId}`;

  async function counts() {
    const [tables] = await pool.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> '__drizzle_migrations'");
    const result: Record<string, number> = {};
    for (const { name } of tables as Array<{ name: string }>) result[name] = ((await pool.query(`SELECT COUNT(*) AS n FROM \`${name}\``))[0] as Array<{ n: number }>)[0]!.n;
    return result;
  }

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    // Banco próprio e vazio, com a mesma estrutura: outros arquivos de teste escrevem em paralelo no banco compartilhado e quebrariam a comparação de contagens.
    const sourceUrl = new URL(integrationUrl!);
    const sourceName = sourceUrl.pathname.slice(1);
    cloneName = `${sourceName}_ow${runId}_test`.slice(0, 60);
    const adminUrl = new URL(integrationUrl!);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection({ uri: adminUrl.toString() });
    await admin.query(`CREATE DATABASE \`${cloneName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const [sourceTables] = await admin.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [sourceName]);
    for (const { name } of sourceTables as Array<{ name: string }>) await admin.query(`CREATE TABLE \`${cloneName}\`.\`${name}\` LIKE \`${sourceName}\`.\`${name}\``);
    const cloneUrl = new URL(integrationUrl!);
    cloneUrl.pathname = `/${cloneName}`;
    validateIsolatedE2EDatabase(cloneUrl.toString(), undefined);
    process.env.DATABASE_URL = cloneUrl.toString();
    const { registerEncounterTimesReceiver, ENCOUNTER_TIMES_PATH } = await import("./encounterTimesReceiver");
    pool = mysql.createPool({ uri: cloneUrl.toString(), connectionLimit: 4 });
    const db = drizzle({ client: pool });
    const [{ id: userId }] = await db.insert(users).values({ openId: `ow-user-${runId}`, name: "Gerente", role: "admin" }).$returningId();
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal OW ${runId}`, documentNumber: `CPF-OW-${runId}`, phone: "11999990004", status: "active" }).$returningId();
    await db.insert(captureRecords).values({ customerId, promoterId: userId, salesRoom: `Sala OW ${runId}`, coupleCode } as never);
    const app = express();
    app.use(express.json());
    registerEncounterTimesReceiver(app, KEY, true);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ENCOUNTER_TIMES_PATH}`;
  });
  afterAll(async () => { process.env = previousEnv; await new Promise(resolve => server?.close(resolve)); await pool?.end(); if (cloneName) await admin?.query(`DROP DATABASE IF EXISTS \`${cloneName}\``); await admin?.end(); });

  it("um evento aceito altera somente encounter_time_records e audit_logs; um evento recusado não altera nada", async () => {
    const send = (payload: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(payload) });
    const good = { eventId: `evt-${runId}-ow`, eventName: "encounter.times_recorded.v1", source: "sales-command", correlationId: `corr-${runId}`, occurredAt: "2026-10-17T15:00:00Z", coupleCode, times: { waitStartedAt: "2026-10-17T14:00:00Z", waitEndedAt: "2026-10-17T14:10:00Z", consultantStartedAt: "2026-10-17T14:10:00Z", consultantEndedAt: "2026-10-17T14:50:00Z" } };

    const beforeRejected = await counts();
    expect((await send({ ...good, eventId: `evt-${runId}-bad`, coupleCode: "TGR-NAO-EXISTE" })).status).toBeGreaterThanOrEqual(400);
    expect(await counts()).toEqual(beforeRejected);

    const before = await counts();
    expect((await send(good)).status).toBe(201);
    const after = await counts();
    const changed = Object.keys(after).filter(name => after[name] !== before[name]).sort();
    expect(changed).toEqual(["audit_logs", "encounter_time_records"]);
  });
});
