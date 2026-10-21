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
import { attendanceRecords, auditLogs, coupleRegistry, customers, resorts } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// C1: receptor encounter.attendance_recorded.v1 em MySQL real, pela rota HTTP. A migration PROPOSTA (migrations/proposed) é aplicada INTEIRA (com as 2 FKs) num
// banco descartável PRÓPRIO deste teste (CREATE DATABASE temporário só com as tabelas-pai: resorts, audit_logs, customers), para não sujar o banco compartilhado que
// schemaDrift.mysql.test.ts compara com o journal. Em produção nada é criado até o GO.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = `chave-teste-${runId}`;
// drizzle embrulha o erro do driver em `cause`; 1452 = ER_NO_REFERENCED_ROW_2 (filho sem pai).
const FK_VIOLATION = { cause: { errno: 1452 } };

describe.skipIf(!integrationUrl)("receptor de atendimento (registro canônico do casal) em MySQL real", () => {
  let pool: mysql.Pool;
  let admin: mysql.Pool;
  let scratchName: string;
  let db: ReturnType<typeof drizzle>;
  let server: Server;
  let offServer: Server;
  let url: string;
  let offUrl: string;
  let resortId: number;
  let attendanceEventId: (encounterId: string, revision: number) => string;
  const previousEnv = { ...process.env };
  const projectKey = randomUUID();
  const coupleId = randomUUID();
  const encounterA = randomUUID();
  const body = (over: Record<string, unknown> = {}) => {
    const encounterId = (over.encounterId as string | undefined) ?? encounterA;
    const revision = (over.revision as number | undefined) ?? 0;
    return {
      eventId: attendanceEventId(encounterId, revision), eventName: "encounter.attendance_recorded.v1", source: "sales-command", correlationId: `corr-${runId}`, occurredAt: "2026-10-21T15:00:00.000Z",
      project: { externalKey: projectKey, name: `Projeto ${runId}`, timezone: "America/Recife" }, encounterId, coupleId, coupleCode: `CP-${runId}`,
      couple: { primaryName: "SYN Ana", secondaryName: "SYN Bruno", phone: "+55 (84) 99999-0001" }, outcome: "NO_SALE", reasonCode: "PRECO", closedAt: "2026-10-21T14:00:00.000Z", revision, ...over,
    };
  };
  const post = (payload: unknown, key: string | null = KEY, target = url) => fetch(target, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(payload) });
  const registry = async () => (await db.select().from(coupleRegistry).where(eq(coupleRegistry.resortId, resortId)));
  const records = async () => { const [row] = await registry(); return row ? db.select().from(attendanceRecords).where(eq(attendanceRecords.coupleRegistryId, row.id)) : []; };

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratchName = `${database.replace(/_test$/i, "")}_att${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratchName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    // LIKE copia colunas e índices, não FKs: só as tabelas-pai que o receptor lê/escreve. As 2 FKs da 0079 vêm da própria proposta.
    for (const table of ["resorts", "audit_logs", "customers"]) await admin.query(`CREATE TABLE \`${scratchName}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const scratchUrl = new URL(integrationUrl!);
    scratchUrl.pathname = `/${scratchName}`;
    process.env.DATABASE_URL = scratchUrl.toString();
    const { registerAttendanceReceiver, ATTENDANCE_PATH, attendanceEventId: derive } = await import("./attendanceReceiver");
    attendanceEventId = derive;
    pool = mysql.createPool({ uri: scratchUrl.toString(), connectionLimit: 6 });
    db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0079_couple_registry_attendance.sql"), "utf8");
    expect(sql.match(/FOREIGN KEY/g)).toHaveLength(2);
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort ATT ${runId}`, externalKey: projectKey, city: "Natal", state: "RN", status: "active" } as never).$returningId();
    const mount = (enabled: boolean) => { const app = express(); app.use(express.json()); registerAttendanceReceiver(app, KEY, enabled); const s = createServer(app); return new Promise<{ s: Server; u: string }>(resolve => s.listen(0, () => resolve({ s, u: `http://127.0.0.1:${(s.address() as AddressInfo).port}${ATTENDANCE_PATH}` }))); };
    ({ s: server, u: url } = await mount(true));
    ({ s: offServer, u: offUrl } = await mount(false));
  });
  afterAll(async () => { process.env = previousEnv;  await new Promise(resolve => server?.close(resolve)); await new Promise(resolve => offServer?.close(resolve)); await pool?.end(); if (scratchName) await admin?.query(`DROP DATABASE IF EXISTS \`${scratchName}\``); await admin?.end(); });

  it("flag desligada: 404 mesmo com a chave certa e nada é gravado; sem chave ou chave errada: 401; corpo inválido: 400", async () => {
    expect((await post(body(), KEY, offUrl)).status).toBe(404);
    expect(await registry()).toHaveLength(0);
    expect((await post(body(), null)).status).toBe(401);
    expect((await post(body(), "errada")).status).toBe(401);
    const invalid = await post({ ...body(), cpf: "123" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ accepted: false, code: "INVALID_EVENT" });
    expect((await post({ ...body(), eventId: randomUUID() })).status).toBe(400);
    expect(await registry()).toHaveLength(0);
  });

  it("projeto desconhecido: 422 UNKNOWN_PROJECT, sem criar resort nem casal", async () => {
    const before = (await db.select().from(resorts)).length;
    const response = await post(body({ project: { externalKey: randomUUID(), name: "Outro", timezone: "America/Recife" } }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ accepted: false, code: "UNKNOWN_PROJECT" });
    expect((await db.select().from(resorts)).length).toBe(before);
    expect(await registry()).toHaveLength(0);
  });

  it("evento novo: 201, casal canônico com PII mínima (telefone só dígitos), histórico e auditoria sem nome nem telefone; resposta sem PII", async () => {
    const customersBefore = (await db.select().from(customers)).length;
    const response = await post(body());
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json).toEqual({ accepted: true, replay: false, eventId: body().eventId });
    const [row] = await registry();
    expect(row).toMatchObject({ salesCoupleId: coupleId, coupleCode: `CP-${runId}`, primaryName: "SYN Ana", secondaryName: "SYN Bruno", phoneDigits: "5584999990001", lastEncounterId: encounterA, lastRevision: 0, lastOutcome: "NO_SALE", lastReasonCode: "PRECO", encountersCount: 1 });
    const [record] = await records();
    expect(record).toMatchObject({ eventId: body().eventId, encounterId: encounterA, revision: 0, outcome: "NO_SALE", reasonCode: "PRECO" });
    expect(Object.keys(record!)).not.toEqual(expect.arrayContaining(["primaryName", "phone"]));
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `audit:attendance:${body().eventId}`));
    expect(audit!.summary).not.toMatch(/SYN Ana|SYN Bruno|9999/);
    expect((await db.select().from(customers)).length).toBe(customersBefore);
  });

  it("reenvio idêntico: 200 replay; mesmo eventId com outro conteúdo: 409 EVENT_ID_CONFLICT; nada duplica", async () => {
    expect((await post(body())).status).toBe(200);
    const conflict = await post(body({ outcome: "NT" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ accepted: false, code: "EVENT_ID_CONFLICT" });
    expect(await records()).toHaveLength(1);
    expect((await registry())[0]!.lastOutcome).toBe("NO_SALE");
  });

  it("correção (revisão 1 do mesmo atendimento) atualiza o estado do casal sem contar outro atendimento; revisão antiga atrasada não regride", async () => {
    expect((await post(body({ revision: 1, outcome: "SALE_CONFIRMED", reasonCode: undefined, couple: { primaryName: "SYN Ana Maria" } }))).status).toBe(201);
    let [row] = await registry();
    expect(row).toMatchObject({ lastRevision: 1, lastOutcome: "SALE_CONFIRMED", lastReasonCode: null, primaryName: "SYN Ana Maria", secondaryName: "SYN Bruno", phoneDigits: "5584999990001", encountersCount: 1 });
    // a revisão 0 chegando de novo atrasada é replay; uma revisão 2 mais nova ainda vale
    expect((await post(body())).status).toBe(200);
    expect((await post(body({ revision: 2, outcome: "NT", reasonCode: "PERFIL" }))).status).toBe(201);
    [row] = await registry();
    expect(row).toMatchObject({ lastRevision: 2, lastOutcome: "NT", lastReasonCode: "PERFIL", encountersCount: 1 });
    expect(await records()).toHaveLength(3);
  });

  it("outro atendimento do mesmo casal: conta +1; o mais antigo não vira o estado atual, o mais novo vira", async () => {
    const older = randomUUID();
    expect((await post(body({ encounterId: older, closedAt: "2026-10-20T10:00:00.000Z", outcome: "CAIU_EM_MESA" }))).status).toBe(201);
    let [row] = await registry();
    expect(row).toMatchObject({ lastEncounterId: encounterA, lastOutcome: "NT", encountersCount: 2 });
    const newer = randomUUID();
    expect((await post(body({ encounterId: newer, closedAt: "2026-10-22T10:00:00.000Z", outcome: "NO_SALE", reasonCode: "PRECO" }))).status).toBe(201);
    [row] = await registry();
    expect(row).toMatchObject({ lastEncounterId: newer, lastOutcome: "NO_SALE", encountersCount: 3 });
    expect(await registry()).toHaveLength(1);
  });

  it("FKs da 0079 existem de verdade: filho sem pai é recusado pelo banco", async () => {
    const [fks] = await pool.query("SELECT CONSTRAINT_NAME AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY 1") as [Array<{ n: string }>, unknown];
    expect(fks.map(f => f.n)).toEqual(["attendance_records_coupleRegistryId_fk", "couple_registry_resortId_fk"]);
    await expect(db.insert(coupleRegistry).values({ resortId: 2_000_000_000, salesCoupleId: randomUUID(), coupleCode: "X", lastEncounterId: randomUUID(), lastRevision: 0, lastOutcome: "NT", lastClosedAt: new Date("2026-10-21T10:00:00Z") })).rejects.toMatchObject(FK_VIOLATION);
    await expect(db.insert(attendanceRecords).values({ eventId: randomUUID(), coupleRegistryId: 2_000_000_000, encounterId: randomUUID(), revision: 0, outcome: "NT", closedAt: new Date("2026-10-21T10:00:00Z"), occurredAt: new Date("2026-10-21T10:00:00Z"), correlationId: "c", payloadHash: "h" })).rejects.toMatchObject(FK_VIOLATION);
  });

  it("corrida: o mesmo eventId em paralelo grava uma linha; atendimentos distintos de um casal NOVO em paralelo criam um só registro", async () => {
    const payload = body({ encounterId: randomUUID(), closedAt: "2026-10-23T10:00:00.000Z" });
    const statuses = (await Promise.all([post(payload), post(payload), post(payload)])).map(r => r.status).sort();
    expect(statuses.filter(s => s === 201)).toHaveLength(1);
    expect(statuses.every(s => s === 201 || s === 200)).toBe(true);
    expect(await db.select().from(attendanceRecords).where(eq(attendanceRecords.eventId, payload.eventId))).toHaveLength(1);

    const freshCouple = randomUUID();
    const parallel = await Promise.all([1, 2, 3].map(i => post(body({ coupleId: freshCouple, coupleCode: `CP-N-${runId}`, encounterId: randomUUID(), closedAt: `2026-10-2${i}T12:00:00.000Z` }))));
    expect(parallel.map(r => r.status)).toEqual([201, 201, 201]);
    const rows = await db.select().from(coupleRegistry).where(eq(coupleRegistry.salesCoupleId, freshCouple));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.encountersCount).toBe(3);
    expect(await db.select().from(attendanceRecords).where(eq(attendanceRecords.coupleRegistryId, rows[0]!.id))).toHaveLength(3);
  });
});
