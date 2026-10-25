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
import { auditLogs, cancellationRequestInbox, commercialFractions, contractCancellationRequests, contracts, customers, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// M-A09-01a: receptor do pedido de cancelamento do Relationship com protocolo (ACK) em MySQL real, pela rota HTTP + a 0090 PROPOSTA aplicada inteira (com FKs) num banco descartável próprio.
// O pedido NÃO cria distrato nem libera a cota; a cota só volta no distrato EXECUTADO (QA-02/QA-04).
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = `chave-relationship-${runId}`;

describe.skipIf(!integrationUrl)("receptor de pedido de cancelamento do Relationship em MySQL real", () => {
  let admin: mysql.Pool;
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let scratchName: string;
  let server: Server;
  let offServer: Server;
  let base: string;
  let offBase: string;
  let adminId: number;
  let customerId: number;
  let resortId: number;
  let unitId: number;
  let seq = 0;
  const previousEnv = { ...process.env };
  const body = (contractId: number, over: Record<string, unknown> = {}) => ({ eventId: `rel-${runId}-${++seq}`, requestId: `req-${runId}-${seq}`, contractId, reasonCode: "customer_request", actor: "rel-user-1", requestedAt: "2026-10-25T10:00:00.000Z", source: "relationship", ...over });
  const headers = (key: string | null) => ({ "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) });
  const post = (payload: unknown, key: string | null = KEY, target = base) => fetch(target, { method: "POST", headers: headers(key), body: JSON.stringify(payload) });
  const get = (protocol: string, key: string | null = KEY, target = base) => fetch(`${target}/${protocol}`, { headers: headers(key) });
  const newContract = async (status = "active") => (await db.insert(contracts).values({ number: `RC-${++seq}-${runId}`, customerId, status, totalAmount: "5000.00", signedAt: new Date() } as never).$returningId())[0]!.id;
  const contractsApi = async () => (await import("./routers/contracts")).contractsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratchName = `${database.replace(/_test$/i, "")}_rc${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratchName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const [tables] = await admin.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'cancellation_request_inbox'", [database]);
    for (const { t } of tables as { t: string }[]) await admin.query(`CREATE TABLE \`${scratchName}\`.\`${t}\` LIKE \`${database}\`.\`${t}\``);
    const scratchUrl = new URL(integrationUrl!);
    scratchUrl.pathname = `/${scratchName}`;
    process.env.DATABASE_URL = scratchUrl.toString();
    const { registerRelationshipCancellationGate, registerRelationshipCancellationReceiver, RELATIONSHIP_CANCELLATION_PATH } = await import("./relationshipCancellationReceiver");
    pool = mysql.createPool({ uri: scratchUrl.toString(), connectionLimit: 8 });
    db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0090_cancellation_request_inbox.sql"), "utf8");
    expect(sql.match(/FOREIGN KEY/g)).toHaveLength(2);
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    [{ id: adminId }] = await db.insert(users).values({ openId: `rc-admin-${runId}`, name: "Admin Sintético", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal RC ${runId}`, documentNumber: `CPF-RC-${runId}`, status: "active" }).$returningId();
    [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort RC ${runId}`, status: "active" }).$returningId();
    [{ id: unitId }] = await db.insert(units).values({ resortId, code: `U-RC-${runId}` }).$returningId();
    const mount = (enabled: boolean) => { const app = express(); registerRelationshipCancellationGate(app, KEY, enabled); app.use(express.json({ limit: "12mb" })); registerRelationshipCancellationReceiver(app, KEY, enabled); const s = createServer(app); return new Promise<{ s: Server; u: string }>(resolve => s.listen(0, () => resolve({ s, u: `http://127.0.0.1:${(s.address() as AddressInfo).port}${RELATIONSHIP_CANCELLATION_PATH}` }))); };
    ({ s: server, u: base } = await mount(true));
    ({ s: offServer, u: offBase } = await mount(false));
  });
  afterAll(async () => { process.env = previousEnv; await new Promise(resolve => server?.close(resolve)); await new Promise(resolve => offServer?.close(resolve)); await pool?.end(); if (scratchName) await admin?.query(`DROP DATABASE IF EXISTS \`${scratchName}\``); await admin?.end(); });

  it("flag desligada: 404 mesmo com a chave certa; sem chave/errada 401; corpo inválido ou campo extra 400; nada gravado", async () => {
    const contractId = await newContract();
    expect((await post(body(contractId), KEY, offBase)).status).toBe(404);
    expect((await get(randomUUID(), KEY, offBase)).status).toBe(404);
    expect((await post(body(contractId), null)).status).toBe(401);
    expect((await post(body(contractId), "errada")).status).toBe(401);
    expect((await get(randomUUID(), null)).status).toBe(401);
    for (const bad of [{ ...body(contractId), cpf: "123" }, { ...body(contractId), reasonCode: "texto livre" }, { ...body(contractId), source: "outro" }, { ...body(contractId), contractId: "x" }]) {
      const response = await post(bad);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ accepted: false, code: "INVALID_EVENT" });
    }
    expect(await db.select().from(cancellationRequestInbox)).toHaveLength(0);
  });

  it("contrato desconhecido 422 UNKNOWN_CONTRACT; contrato já cancelado 422 CONTRACT_ALREADY_CANCELLED; nada gravado", async () => {
    const unknown = await post(body(2_000_000_000));
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ accepted: false, code: "UNKNOWN_CONTRACT" });
    const done = await post(body(await newContract("cancelled")));
    expect(done.status).toBe(422);
    expect(await done.json()).toMatchObject({ code: "CONTRACT_ALREADY_CANCELLED" });
    expect(await db.select().from(cancellationRequestInbox)).toHaveLength(0);
  });

  it("pedido novo: 201 com protocolo persistido (ACK), trilha sem PII, nenhum distrato aberto; replay 200 com o MESMO protocolo; outro conteúdo no mesmo id 409", async () => {
    const contractId = await newContract();
    const payload = body(contractId);
    const created = await post(payload);
    expect(created.status).toBe(201);
    const ack = await created.json() as { accepted: boolean; replay: boolean; eventId: string; protocol: string };
    expect(ack).toMatchObject({ accepted: true, replay: false, eventId: payload.eventId });
    expect(ack.protocol).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await db.select().from(cancellationRequestInbox).where(eq(cancellationRequestInbox.protocol, ack.protocol));
    expect(row).toMatchObject({ contractId, eventId: payload.eventId, requestId: payload.requestId, reasonCode: "customer_request", cancellationRequestId: null });
    expect(await db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.contractId, contractId))).toHaveLength(0);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `audit:relationship-cancel:${payload.eventId}`));
    expect(audit!.summary).not.toMatch(/Casal RC|CPF/);
    const replay = await post(payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replay: true, protocol: ack.protocol });
    const sameRequestNewEvent = await post({ ...payload, eventId: `${payload.eventId}-b` });
    expect(sameRequestNewEvent.status).toBe(409);
    const conflict = await post({ ...payload, reasonCode: "payment_default" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ accepted: false, code: "EVENT_ID_CONFLICT" });
    expect(await db.select().from(cancellationRequestInbox).where(eq(cancellationRequestInbox.contractId, contractId))).toHaveLength(1);
  });

  it("corrida: o mesmo pedido em paralelo grava uma linha e todos recebem o mesmo protocolo", async () => {
    const contractId = await newContract();
    const payload = body(contractId);
    const responses = await Promise.all([post(payload), post(payload), post(payload), post(payload)]);
    expect(responses.map(r => r.status).filter(s => s === 201)).toHaveLength(1);
    expect(responses.every(r => r.status === 201 || r.status === 200)).toBe(true);
    const protocols = new Set((await Promise.all(responses.map(r => r.json()))).map((j: { protocol: string }) => j.protocol));
    expect(protocols.size).toBe(1);
    expect(await db.select().from(cancellationRequestInbox).where(eq(cancellationRequestInbox.contractId, contractId))).toHaveLength(1);
  });

  it("consulta do protocolo devolve o estado e acompanha o distrato do CRM; a cota SÓ volta no distrato executado", async () => {
    const contractId = await newContract();
    const [fraction] = await db.insert(commercialFractions).values({ resortId, unitId, code: `F-RC-${runId}`, sequence: 1, status: "sold", currentContractId: contractId, listPrice: "1000.00" }).$returningId();
    const ack = await (await post(body(contractId))).json() as { protocol: string };
    expect(await (await get(ack.protocol)).json()).toMatchObject({ protocol: ack.protocol, contractId, status: "received" });
    expect((await get(randomUUID())).status).toBe(404);
    expect((await get("nao-e-protocolo")).status).toBe(404);

    const api = await contractsApi();
    const opened = await api.openCancellationFromInbox({ protocol: ack.protocol });
    expect(opened.reused).toBe(false);
    expect((await api.openCancellationFromInbox({ protocol: ack.protocol }))).toMatchObject({ cancellationRequestId: opened.cancellationRequestId, reused: true });
    expect(await db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.contractId, contractId))).toHaveLength(1);
    expect(await (await get(ack.protocol)).json()).toMatchObject({ status: "under_review" });
    const fractionOf = async () => (await db.select().from(commercialFractions).where(eq(commercialFractions.id, fraction.id)))[0]!;
    expect((await fractionOf()).status).toBe("sold");

    await api.decideCancellation({ requestId: opened.cancellationRequestId, decision: "approved" });
    expect(await (await get(ack.protocol)).json()).toMatchObject({ status: "approved" });
    expect(await fractionOf()).toMatchObject({ status: "sold", currentContractId: contractId });

    await api.executeCancellation({ requestId: opened.cancellationRequestId });
    expect(await (await get(ack.protocol)).json()).toMatchObject({ status: "executed" });
    expect((await fractionOf()).status).toBe("available");
  });

  it("segundo pedido do mesmo contrato com distrato já aberto liga ao existente e NÃO duplica o distrato", async () => {
    const contractId = await newContract();
    const api = await contractsApi();
    const first = await (await post(body(contractId))).json() as { protocol: string };
    const second = await (await post(body(contractId))).json() as { protocol: string };
    expect(second.protocol).not.toBe(first.protocol);
    const a = await api.openCancellationFromInbox({ protocol: first.protocol });
    const b = await api.openCancellationFromInbox({ protocol: second.protocol });
    expect(b).toMatchObject({ cancellationRequestId: a.cancellationRequestId, reused: true });
    expect(await db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.contractId, contractId))).toHaveLength(1);
  });

  it("0090 inteira com as FKs: filho sem pai é recusado (errno 1452)", async () => {
    await expect(db.insert(cancellationRequestInbox).values({ protocol: randomUUID(), eventId: `fk-${runId}`, requestId: `fkr-${runId}`, payloadHash: "x", contractId: 2_000_000_000, reasonCode: "other", actor: "a", requestedAt: new Date() })).rejects.toMatchObject({ cause: { errno: 1452 } });
  });
});
