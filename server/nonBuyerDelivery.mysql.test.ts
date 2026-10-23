import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureMotives, captureRecords, customerContactOptouts, customers, domainEvents, nonBuyerDeliveries, resorts } from "../drizzle/schema";
import { eligibleBodySchema, revokedBodySchema } from "../shared/nonBuyerDeliveryContract";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// F2.1: bomba de entrega ao Recovery em MySQL real + servidor HTTP falso. A 0080 e a 0089 PROPOSTAS são aplicadas INTEIRAS num banco descartável próprio (dropado no fim).
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

type Hit = { url: string; headers: http.IncomingHttpHeaders; body: any };

describe.skipIf(!integrationUrl)("entrega de não-comprador ao Recovery em MySQL real", () => {
  let admin: mysql.Pool;
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let scratchName: string;
  let svc: typeof import("./nonBuyerEligibilityService");
  let delivery: typeof import("./nonBuyerDelivery");
  let server: http.Server;
  let endpoint = "";
  let hits: Hit[] = [];
  let respond: (hit: Hit) => { status: number; json?: unknown } = () => ({ status: 201 });
  let seq = 0;
  let resortId = 0;
  const previousEnv = { ...process.env };
  const KEY = "chave-sintetica-de-teste";
  const config = (extra: Record<string, unknown> = {}) => ({ endpoint, key: KEY, ...extra }) as Parameters<typeof delivery.runNonBuyerDelivery>[1];

  const couple = async (patch: Record<string, unknown> = {}) => {
    const n = ++seq;
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Entrega ${n} ${runId}`, documentNumber: `CPF-DL-${n}-${runId}`, phone: `1196666${String(n).padStart(4, "0")}`, status: "active" }).$returningId();
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId, resortId, salesRoom: `Sala DL ${runId}`, coupleCode: `DL-${n}-${runId}`, presentationStatus: "closed", presentationEndedAt: new Date("2026-10-21T14:00:00Z"), ...patch } as never).$returningId();
    return { customerId, captureId, code: `DL-${n}-${runId}`, name: `Casal Entrega ${n} ${runId}`, phone: `1196666${String(n).padStart(4, "0")}` };
  };
  const reevaluate = (captureId: number) => db.transaction(tx => svc.reevaluateCapture(tx, captureId));
  const rowOf = async (eventId: string) => (await db.select().from(nonBuyerDeliveries).where(eq(nonBuyerDeliveries.eventId, eventId)))[0];
  const run = (extra: Record<string, unknown> = {}) => delivery.runNonBuyerDelivery(db as never, config(extra));

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratchName = `${database.replace(/_test$/i, "")}_dl${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratchName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["customers", "capture_records", "domain_events", "contracts", "opportunities", "proposals", "capture_erasure_requests", "resorts", "financial_project_map", "capture_motives"]) await admin.query(`CREATE TABLE \`${scratchName}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const scratchUrl = new URL(integrationUrl!);
    scratchUrl.pathname = `/${scratchName}`;
    process.env.DATABASE_URL = scratchUrl.toString();
    pool = mysql.createPool({ uri: scratchUrl.toString(), connectionLimit: 12 });
    db = drizzle({ client: pool });
    for (const file of ["PROPOSED_0080_contact_optouts_eligibility_state.sql", "PROPOSED_0089_non_buyer_deliveries.sql"]) {
      const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed", file), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    }
    svc = await import("./nonBuyerEligibilityService");
    delivery = await import("./nonBuyerDelivery");
    [{ id: resortId }] = await db.insert(resorts).values({ externalKey: `syn-proj-${runId}`, name: `Empreendimento ${runId}` }).$returningId();
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const hit: Hit = { url: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
        hits.push(hit);
        const answer = respond(hit);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.json ?? {}));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    hits = [];
    respond = () => ({ status: 201 });
    // cada teste começa sem fila pendente herdada
    await db.update(nonBuyerDeliveries).set({ status: "superseded", reason: "test_reset" }).where(eq(nonBuyerDeliveries.status, "pending"));
    const discoveredOld = await db.select({ key: domainEvents.idempotencyKey }).from(domainEvents);
    for (const { key } of discoveredOld) {
      const m = key ? /^crm-nb-(\d+)-(eligible|revoked)-(\d+)$/.exec(key) : null;
      if (m && !(await rowOf(key!))) await db.insert(nonBuyerDeliveries).values({ eventId: key!, captureId: Number(m[1]), seq: Number(m[3]), kind: m[2] as "eligible" | "revoked", status: "superseded", reason: "test_reset" });
    }
  });
  afterAll(async () => { process.env = previousEnv; server?.close(); await pool?.end(); if (scratchName) await admin?.query(`DROP DATABASE IF EXISTS \`${scratchName}\``); await admin?.end(); });

  it("elegível: entrega UM corpo válido ao contrato, com contato só no corpo HTTP; replay não reenvia; livro e domain_events sem PII", async () => {
    const c = await couple();
    await reevaluate(c.captureId);
    const logs: string[] = [];
    const { logger } = await import("./logger");
    const spies = (["info", "warn", "error"] as const).map(level => vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => { logs.push(JSON.stringify(args)); }));
    const outcome = await run();
    spies.forEach(spy => spy.mockRestore());
    expect(outcome).toMatchObject({ delivered: 1, suppressed: 0, retried: 0 });
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.url).toBe("/non-buyer/eligible");
    expect(hit.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(hit.headers["idempotency-key"]).toBe(`crm-nb-${c.captureId}-eligible-1`);
    expect(eligibleBodySchema.parse(hit.body)).toMatchObject({
      eventId: `crm-nb-${c.captureId}-eligible-1`, coupleCode: c.code, encounterDate: "2026-10-21", dedupeKey: `${c.code}:2026-10-21`, branch: "closed",
      project: { externalKey: `syn-proj-${runId}`, timezone: "America/Recife" }, contact: { name: c.name, phone: c.phone },
    });
    expect(await rowOf(`crm-nb-${c.captureId}-eligible-1`)).toMatchObject({ status: "delivered", attempts: 1, lastHttpStatus: 201 });
    // PII: nem o evento interno, nem o livro, nem os logs
    const events = await db.select().from(domainEvents).where(eq(domainEvents.idempotencyKey, `crm-nb-${c.captureId}-eligible-1`));
    expect(events[0]!.payload).not.toContain(c.name);
    expect(JSON.stringify(await db.select().from(nonBuyerDeliveries).where(eq(nonBuyerDeliveries.captureId, c.captureId)))).not.toMatch(new RegExp(`${c.name}|${c.phone}|${c.code}`));
    expect(logs.join("\n")).not.toMatch(new RegExp(`${c.name}|${c.phone}|${c.code}|${KEY}`));
    hits = [];
    expect(await run()).toMatchObject({ delivered: 0, discovered: 0 });
    expect(hits).toHaveLength(0);
  });

  it("REVALIDAÇÃO NA ENTREGA: opt-out gravado depois do evento e antes do envio => NÃO envia, suprime e o revogado também não vai (nunca foi entregue)", async () => {
    const c = await couple();
    await reevaluate(c.captureId); // eligible 1 gravado
    await db.insert(customerContactOptouts).values({ customerId: c.customerId, coupleCode: c.code, optedOutAt: new Date(), source: "recovery", eventId: `syn-optout-${c.captureId}-${runId}` });
    const outcome = await run();
    expect(hits).toHaveLength(0); // sem a revalidação o elegível velho seria enviado
    expect(outcome).toMatchObject({ delivered: 0, suppressed: 1 });
    expect(await rowOf(`crm-nb-${c.captureId}-eligible-1`)).toMatchObject({ status: "suppressed", reason: "revalidated_ineligible" });
    const events = await db.select().from(domainEvents).where(eq(domainEvents.aggregateId, String(c.captureId)));
    expect(events.map(e => e.eventName).sort()).toEqual(["non_buyer.eligibility_revoked", "non_buyer.eligible"]);
    expect(JSON.parse(events.find(e => e.eventName === "non_buyer.eligibility_revoked")!.payload!)).toMatchObject({ reason: "opt_out", seq: 2 });
    await run();
    expect(hits).toHaveLength(0);
    expect(await rowOf(`crm-nb-${c.captureId}-revoked-2`)).toMatchObject({ status: "suppressed", reason: "never_delivered" });
  });

  it("revogado só vai se um elegível dessa ficha foi entregue; leva o motivo, o coupleCode e a MESMA chave de dedupe do elegível", async () => {
    const c = await couple();
    await reevaluate(c.captureId);
    await run();
    const eligible = hits[0]!.body;
    await db.insert(customerContactOptouts).values({ customerId: c.customerId, coupleCode: c.code, optedOutAt: new Date(), source: "recovery", eventId: `syn-optout2-${c.captureId}-${runId}` });
    await reevaluate(c.captureId); // revoked 2 (opt_out)
    hits = [];
    expect(await run()).toMatchObject({ delivered: 1 });
    expect(hits[0]!.url).toBe("/non-buyer/eligibility-revoked");
    const body = revokedBodySchema.parse(hits[0]!.body);
    expect(body).toMatchObject({ eventId: `crm-nb-${c.captureId}-revoked-2`, reason: "opt_out", coupleCode: c.code });
    expect(body.dedupeKey).toBe(eligible.dedupeKey);
    expect(JSON.stringify(hits[0]!.body)).not.toMatch(new RegExp(`${c.name}|${c.phone}`));
  });

  it("evento velho com um mais novo na ficha é superseded e não é enviado (só o estado vigente vale)", async () => {
    const c = await couple();
    await reevaluate(c.captureId); // eligible 1 (pendente)
    await db.insert(customerContactOptouts).values({ customerId: c.customerId, coupleCode: c.code, optedOutAt: new Date(), source: "recovery", eventId: `syn-optout3-${c.captureId}-${runId}` });
    await reevaluate(c.captureId); // revoked 2
    await run();
    expect(hits).toHaveLength(0);
    expect(await rowOf(`crm-nb-${c.captureId}-eligible-1`)).toMatchObject({ status: "superseded", reason: "newer_event" });
  });

  it("falha transitória: 503/401/rede/recusa sem code tentam de novo com backoff persistido e sem duplicar; sucesso depois entrega uma vez", async () => {
    const c = await couple();
    await reevaluate(c.captureId);
    const start = new Date("2026-10-23T10:00:00Z");
    respond = () => ({ status: 503 });
    expect(await run({ now: () => start })).toMatchObject({ retried: 1, delivered: 0 });
    let row = (await rowOf(`crm-nb-${c.captureId}-eligible-1`))!;
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastHttpStatus: 503, reason: "http_503" });
    expect(row.nextAttemptAt!.getTime()).toBe(start.getTime() + 5_000);
    // antes de vencer o backoff, nada é enviado
    hits = [];
    expect(await run({ now: () => new Date(start.getTime() + 1_000) })).toMatchObject({ retried: 0, delivered: 0 });
    expect(hits).toHaveLength(0);
    respond = () => ({ status: 401 });
    await run({ now: () => new Date(start.getTime() + 6_000) });
    row = (await rowOf(`crm-nb-${c.captureId}-eligible-1`))!;
    expect(row).toMatchObject({ status: "pending", attempts: 2, lastHttpStatus: 401 });
    respond = () => ({ status: 400, json: { error: "x" } }); // 400 SEM code: não é terminal
    await run({ now: () => new Date(start.getTime() + 60_000) });
    expect(await rowOf(`crm-nb-${c.captureId}-eligible-1`)).toMatchObject({ status: "pending", attempts: 3 });
    respond = () => ({ status: 200 });
    hits = [];
    await run({ now: () => new Date(start.getTime() + 600_000) });
    expect(hits).toHaveLength(1);
    expect(await rowOf(`crm-nb-${c.captureId}-eligible-1`)).toMatchObject({ status: "delivered", attempts: 4, lastHttpStatus: 200 });
  });

  it("recusa 4xx com code é terminal (rejected) e não é reenviada; 429 com code continua tentando", async () => {
    const a = await couple();
    await reevaluate(a.captureId);
    respond = () => ({ status: 422, json: { code: "UNKNOWN_COUPLE_CODE" } });
    expect(await run()).toMatchObject({ rejected: 1 });
    expect(await rowOf(`crm-nb-${a.captureId}-eligible-1`)).toMatchObject({ status: "rejected", reason: "UNKNOWN_COUPLE_CODE", lastHttpStatus: 422 });
    hits = [];
    await run({ now: () => new Date(Date.now() + 3_600_000) });
    expect(hits).toHaveLength(0);
    const b = await couple();
    await reevaluate(b.captureId);
    respond = () => ({ status: 429, json: { code: "RATE_LIMITED" } });
    expect(await run()).toMatchObject({ rejected: 0, retried: 1 });
    expect(await rowOf(`crm-nb-${b.captureId}-eligible-1`)).toMatchObject({ status: "pending" });
  });

  it("sem coupleCode ou sem projeto não envia (espera, com backoff) e não vaza nada", async () => {
    const noCode = await couple({ coupleCode: null });
    const noProject = await couple({ resortId: null });
    await reevaluate(noCode.captureId);
    await reevaluate(noProject.captureId);
    expect(await run()).toMatchObject({ retried: 2, delivered: 0 });
    expect(hits).toHaveLength(0);
    expect(await rowOf(`crm-nb-${noCode.captureId}-eligible-1`)).toMatchObject({ status: "pending", reason: "no_couple_code" });
    expect(await rowOf(`crm-nb-${noProject.captureId}-eligible-1`)).toMatchObject({ status: "pending", reason: "no_project" });
  });

  it("branch no_tour leva o código do motivo (nunca texto livre)", async () => {
    const [{ id: motiveId }] = await db.insert(captureMotives).values({ kind: "nt_perfil", code: `syn_motive_${runId}`, label: "Motivo sintetico" }).$returningId();
    const c = await couple({ presentationStatus: "no_tour", presentationEndedAt: null, ntKind: "perfil", ntMotiveId: motiveId, ntRecordedAt: new Date("2026-10-22T02:30:00Z"), ntComplement: "texto livre que NAO pode sair" });
    await reevaluate(c.captureId);
    await run();
    const body = eligibleBodySchema.parse(hits[0]!.body);
    expect(body).toMatchObject({ branch: "no_tour", reasonCode: `syn_motive_${runId}`, encounterDate: "2026-10-21" });
    expect(JSON.stringify(hits[0]!.body)).not.toContain("texto livre");
  });

  it("configuração incompleta (sem chave ou endpoint inválido) não envia nem descobre nada", async () => {
    const c = await couple();
    await reevaluate(c.captureId);
    expect(await delivery.runNonBuyerDelivery(db as never, { endpoint, key: "" })).toMatchObject({ discovered: 0, delivered: 0 });
    expect(await delivery.runNonBuyerDelivery(db as never, { endpoint: "http://recovery.example", key: KEY })).toMatchObject({ discovered: 0, delivered: 0 });
    expect(hits).toHaveLength(0);
    expect(await db.select().from(nonBuyerDeliveries).where(eq(nonBuyerDeliveries.captureId, c.captureId))).toHaveLength(0);
  });
});
