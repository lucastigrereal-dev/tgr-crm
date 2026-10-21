import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, contracts, customers, domainEvents, nonBuyerEligibilityState, opportunities } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// C2/C3 fatia 4: ganchos, AUTO_INCREMENT da projeção e pool da leitura fresca, em MySQL real. A 0080 PROPOSTA inteira num banco descartável próprio (dropado no fim).
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = `chave-hooks-${runId}`;

describe.skipIf(!integrationUrl)("elegibilidade de não-comprador: ganchos, AUTO_INCREMENT e pool em MySQL real", () => {
  let admin: mysql.Pool;
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let scratchName: string;
  let svc: typeof import("./nonBuyerEligibilityService");
  let fresh: typeof import("./nonBuyerFreshReader");
  let seq = 0;
  const previousEnv = { ...process.env };
  const previousFlag = ENV.recoveryEligibilityEnabled;

  const couple = async (patch: Record<string, unknown> = {}, customerId?: number) => {
    const n = ++seq;
    const cid = customerId ?? (await db.insert(customers).values({ fullName: `Casal HK ${n} ${runId}`, documentNumber: `CPF-HK-${n}-${runId}`, phone: `1196666${String(n).padStart(4, "0")}`, status: "active" }).$returningId())[0]!.id;
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: cid, salesRoom: `Sala HK ${runId}`, coupleCode: `HK-${n}-${runId}`, presentationStatus: "closed", presentationEndedAt: new Date("2026-10-21T14:00:00Z"), ...patch } as never).$returningId();
    await db.insert(opportunities).values({ customerId: cid, title: `Op HK ${n}`, stage: "qualified" } as never);
    return { customerId: cid, captureId, code: `HK-${n}-${runId}` };
  };
  const eventsOf = async (captureId: number) => (await db.select().from(domainEvents).where(and(eq(domainEvents.aggregateType, "capture"), eq(domainEvents.aggregateId, String(captureId)), like(domainEvents.eventName, "non_buyer.%")))).sort((a, b) => a.id - b.id);
  const stateOf = async (captureId: number) => (await db.select().from(nonBuyerEligibilityState).where(eq(nonBuyerEligibilityState.captureId, captureId)))[0];
  const autoIncrement = async () => {
    const conn = await pool.getConnection();
    try {
      await conn.query("SET SESSION information_schema_stats_expiry = 0");
      const [rows] = await conn.query("SELECT AUTO_INCREMENT AS a FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'non_buyer_eligibility_state'") as [Array<{ a: number | string }>, unknown];
      return Number(rows[0]!.a);
    } finally { conn.release(); }
  };
  const newContract = (customerId: number, n: string) => ({ number: `HK-${n}-${runId}`, customerId, usageModel: "fixed_week", status: "active", totalAmount: "1000.00" }) as never;

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratchName = `${database.replace(/_test$/i, "")}_hk${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratchName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["customers", "capture_records", "domain_events", "audit_logs", "contracts", "opportunities", "proposals", "capture_erasure_requests"]) await admin.query(`CREATE TABLE \`${scratchName}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const scratchUrl = new URL(integrationUrl!);
    scratchUrl.pathname = `/${scratchName}`;
    process.env.DATABASE_URL = scratchUrl.toString();
    pool = mysql.createPool({ uri: scratchUrl.toString(), connectionLimit: 12 });
    db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0080_contact_optouts_eligibility_state.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    ENV.recoveryEligibilityEnabled = true;
    svc = await import("./nonBuyerEligibilityService");
    fresh = await import("./nonBuyerFreshReader");
  });
  afterAll(async () => {
    ENV.recoveryEligibilityEnabled = previousFlag;
    process.env = previousEnv;
    await fresh?.closeFreshReader();
    await pool?.end();
    if (scratchName) await admin?.query(`DROP DATABASE IF EXISTS \`${scratchName}\``);
    await admin?.end();
  });

  it("AUTO_INCREMENT: reavaliar ficha com linha de estado existente NÃO consome id (a reconciliação de 10 min não estoura o int); a projeção usa id bigint", async () => {
    const c = await couple();
    await db.transaction(tx => svc.reevaluateCapture(tx, c.captureId)); // cria a linha
    const before = await autoIncrement();
    for (let i = 0; i < 25; i++) await db.transaction(tx => svc.reevaluateCapture(tx, c.captureId));
    await svc.reconcileAllNonBuyerEligibility(db);
    expect(await autoIncrement()).toBe(before);
    const [columns] = await pool.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'non_buyer_eligibility_state' AND COLUMN_NAME = 'id'") as [Array<{ t: string }>, unknown];
    expect(columns[0]!.t).toMatch(/^bigint/);
  });

  it("pool: 12 ganchos concorrentes com o pool PRINCIPAL de 2 conexões não travam (a leitura fresca usa o pool dedicado de 3) e todos comitam", async () => {
    const small = mysql.createPool({ uri: process.env.DATABASE_URL!, connectionLimit: 2, waitForConnections: true });
    const smallDb = drizzle({ client: small });
    try {
      const targets = [] as Array<{ customerId: number; captureId: number }>;
      for (let i = 0; i < 12; i++) targets.push(await couple());
      const started = Date.now();
      await Promise.all(targets.map(t => smallDb.transaction(async tx => {
        await tx.insert(contracts).values(newContract(t.customerId, `pool-${t.captureId}`));
        await svc.eligibilityHook(tx, { customerId: t.customerId });
      })));
      expect(Date.now() - started).toBeLessThan(20_000);
      for (const t of targets) expect(await stateOf(t.captureId)).toMatchObject({ eligible: false, seq: 0 }); // inelegível desde o início (contrato ativo): estado criado, sem evento
      // elegíveis → o contrato novo revoga: prova o caminho com evento sob a mesma concorrência
      const eligible = [] as Array<{ customerId: number; captureId: number }>;
      for (let i = 0; i < 12; i++) eligible.push(await couple());
      await Promise.all(eligible.map(t => db.transaction(tx => svc.reevaluateCapture(tx, t.captureId))));
      await Promise.all(eligible.map(t => smallDb.transaction(async tx => {
        await tx.insert(contracts).values(newContract(t.customerId, `pool2-${t.captureId}`));
        await svc.eligibilityHook(tx, { customerId: t.customerId });
      })));
      for (const t of eligible) { expect(await stateOf(t.captureId)).toMatchObject({ eligible: false, seq: 2 }); expect(await eventsOf(t.captureId)).toHaveLength(2); }
    } finally { await small.end(); }
  });

  it("o gancho é atômico com o fato: comita junto; se a tx de negócio falha depois do gancho, nada fica (nem contrato, nem estado, nem evento)", async () => {
    const ok = await couple();
    await db.transaction(tx => svc.reevaluateCapture(tx, ok.captureId)); // elegível seq 1
    await db.transaction(async tx => { await tx.insert(contracts).values(newContract(ok.customerId, "atomic-ok")); await svc.eligibilityHook(tx, { customerId: ok.customerId }); });
    expect(await stateOf(ok.captureId)).toMatchObject({ eligible: false, seq: 2, lastReason: "sale_in_progress" });
    expect((await eventsOf(ok.captureId)).map(e => e.eventName)).toEqual(["non_buyer.eligible", "non_buyer.eligibility_revoked"]);

    const bad = await couple();
    await db.transaction(tx => svc.reevaluateCapture(tx, bad.captureId));
    await expect(db.transaction(async tx => {
      await tx.insert(contracts).values(newContract(bad.customerId, "atomic-bad"));
      await svc.eligibilityHook(tx, { customerId: bad.customerId });
      throw new Error("negócio falhou depois do gancho");
    })).rejects.toThrow("negócio falhou");
    expect(await stateOf(bad.captureId)).toMatchObject({ eligible: true, seq: 1 });
    expect(await eventsOf(bad.captureId)).toHaveLength(1);
    expect(await db.select().from(contracts).where(eq(contracts.customerId, bad.customerId))).toHaveLength(0);
  });

  it("falha do gancho NÃO derruba a tx de negócio: leitura fresca quebrada => contrato comita, estado intacto, reconciliação converge", async () => {
    const c = await couple();
    await db.transaction(tx => svc.reevaluateCapture(tx, c.captureId)); // elegível
    const deadPool = mysql.createPool({ uri: process.env.DATABASE_URL!, connectionLimit: 1 });
    const deadDb = drizzle({ client: deadPool });
    await deadPool.end(); // qualquer leitura nele falha
    await db.transaction(async tx => {
      await tx.insert(contracts).values(newContract(c.customerId, "hookfail"));
      await svc.eligibilityHook(tx, { customerId: c.customerId }, true, deadDb as never); // não lança
    });
    expect(await db.select().from(contracts).where(eq(contracts.customerId, c.customerId))).toHaveLength(1); // negócio comitou
    expect(await stateOf(c.captureId)).toMatchObject({ eligible: true, seq: 1 }); // gancho desfeito pelo savepoint; nada pela metade
    await svc.reconcileAllNonBuyerEligibility(db);
    expect(await stateOf(c.captureId)).toMatchObject({ eligible: false, seq: 2 }); // a reconciliação cobre
  });

  it("flag desligada: o gancho não escreve nada (nem cria a linha de estado)", async () => {
    const c = await couple();
    await db.transaction(async tx => { await svc.eligibilityHook(tx, { customerId: c.customerId }, false); });
    expect(await stateOf(c.captureId)).toBeUndefined();
    await svc.eligibilityHookAfterCommit({ captureId: c.captureId }, false);
    expect(await stateOf(c.captureId)).toBeUndefined();
  });

  it("pós-commit (rotas não transacionais): atendimento encerrado vira elegível; VENDEU revoga", async () => {
    const c = await couple({ presentationStatus: "presented", presentationEndedAt: null });
    await svc.eligibilityHookAfterCommit({ captureId: c.captureId }, true);
    expect(await stateOf(c.captureId)).toMatchObject({ eligible: false, seq: 0 });
    await db.update(captureRecords).set({ presentationStatus: "closed", presentationEndedAt: new Date("2026-10-21T15:00:00Z") }).where(eq(captureRecords.id, c.captureId));
    await svc.eligibilityHookAfterCommit({ captureId: c.captureId }, true);
    expect(await stateOf(c.captureId)).toMatchObject({ eligible: true, seq: 1 });
    await db.update(captureRecords).set({ commercialOutcome: "vendeu" }).where(eq(captureRecords.id, c.captureId));
    await svc.eligibilityHookAfterCommit({ captureId: c.captureId }, true);
    expect(await stateOf(c.captureId)).toMatchObject({ eligible: false, seq: 2, lastReason: "sale_in_progress" });
  });

  it("receptor de opt-out (tx de negócio) revoga na mesma transação, sem PII no evento", async () => {
    const { registerRecoveryOptOutGate, registerRecoveryOptOutReceiver, RECOVERY_OPTOUT_PATH } = await import("./recoveryOptOutReceiver");
    const c = await couple();
    await db.transaction(tx => svc.reevaluateCapture(tx, c.captureId)); // elegível
    const app = express();
    registerRecoveryOptOutGate(app, KEY, true);
    app.use(express.json());
    registerRecoveryOptOutReceiver(app, KEY, true);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${RECOVERY_OPTOUT_PATH}`;
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify({ eventId: `rec-hk-${runId}`, coupleCode: c.code, optedOutAt: "2026-10-21T16:00:00.000Z", source: "recovery" }) });
      expect(response.status).toBe(201);
    } finally { await new Promise(resolve => server.close(resolve)); }
    expect(await stateOf(c.captureId)).toMatchObject({ eligible: false, seq: 2, lastReason: "opt_out" });
    const events = await eventsOf(c.captureId);
    expect(events.map(e => e.eventName)).toEqual(["non_buyer.eligible", "non_buyer.eligibility_revoked"]);
    expect(events[1]!.payload).not.toMatch(/Casal HK|CPF|1196666/);
  });

  it("os pontos de negócio chamam o gancho como ÚLTIMO passo (contratos, vendas, captura, exclusão, opt-out, Sales ingest) e a falha dele não sobe", () => {
    const read = (file: string) => readFileSync(path.resolve(__dirname, file), "utf8");
    const sites: Array<[string, RegExp]> = [
      ["routers/contracts.ts", /eligibilityHook\(tx, \{ customerId: input\.customerId \}\);[^\n]*\n\s*return contractId;/],
      ["routers/contracts.ts", /eligibilityHook\(tx, \{ customerId: contract\.customerId \}\);[^\n]*\n\s*return \{ policyConfigured/],
      ["routers/contracts.ts", /eligibilityHook\(tx, \{ customerId: current\.customerId \}\)/],
      ["routers/sales.ts", /eligibilityHook\(tx, \{ customerId: opportunity\.customerId \}\);[^\n]*\n\s*return proposalId;/],
      ["routers/sales.ts", /eligibilityHook\(tx, \{ customerId \}\)/],
      ["routers/captureSheet.ts", /eligibilityHook\(tx, \{ captureId: capture\.id \}\);[^\n]*\n\s*return \{ ok: true as const, alreadyRecorded: false/],
      ["routers/captures.ts", /eligibilityHookAfterCommit\(\{ captureId: input\.id \}\)/],
      ["captureErasure.ts", /eligibilityHook\(tx, \{ customerId: customer\.id \}\)/],
      ["recoveryOptOutReceiver.ts", /eligibilityHook\(tx, \{ customerId: capture\.customerId \}\);[^\n]*\n\s*return \{ replay: false/],
      ["salesCommandBridge.ts", /eligibilityHook\(tx, \{ customerId \}\);[^\n]*\n\s*return \{\s*\n\s*customerId,/],
    ];
    for (const [file, pattern] of sites) expect(pattern.test(read(file)), `${file} ${pattern}`).toBe(true);
    const service = read("nonBuyerEligibilityService.ts");
    expect(service).toMatch(/catch \(error\) \{\s*\n\s*logger\.warn\("Non-buyer eligibility hook failed/);
  });
});
