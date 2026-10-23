import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureGuestpassLinks, captureRecords, customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// F1.8 / CRM-a e CRM-b em MySQL real. A migration PROPOSTA 0087 é aplicada INTEIRA (com as 2 FKs e o CHECK) num banco descartável PRÓPRIO deste teste, só com as tabelas
// que a ficha usa; em produção nada é criado até o GO. O GuestPass é um servidor HTTP falso local com dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = `chave-ponte-${runId}`;
const hex = (seed: number) => `GP-${(0xA0000000 + seed).toString(16).toUpperCase()}`;

describe.skipIf(!integrationUrl)("vínculo passe-ficha e busca de passe do GuestPass (MySQL real, 0087 PROPOSTA)", () => {
  let admin: mysql.Pool; let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let scratch = ""; let userId = 0; let guestpass: Server;
  const previousEnv = { ...process.env };
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  let mode: "ok" | "forbidden" | "unauthorized" | "missing" = "ok";
  let phone = "";
  const caller = async (role: "admin" | "seller" | "service" = "seller") => {
    const { appRouter } = await import("./routers");
    return appRouter.createCaller({ user: { id: userId, role }, req: {}, res: {} } as never);
  };
  const reset = () => { process.env.CRM_GUESTPASS_PREFILL_ENABLED = "true"; mode = "ok"; seen.length = 0; };
  let seq = 0;
  const newPass = () => hex(++seq + Math.floor(Math.random() * 1e6));
  const newCapture = async (name = `SYN Casal ${runId}-${seq}`, customerPhone: string | null = null) => {
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: name, phone: customerPhone, status: "active" } as never).$returningId();
    const [{ id }] = await db.insert(captureRecords).values({ customerId } as never).$returningId();
    return { id, customerId };
  };
  const captureInput = (over: Record<string, unknown> = {}) => ({ customer: { fullName: `SYN Titular ${runId} ${++seq}`, phone: `8499${String(seq).padStart(3, "0")}${runId.replace(/\D/g, "0").slice(0, 4).padEnd(4, "0")}` }, createOpportunity: false, ...over });

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratch = `${database.replace(/_test$/i, "")}_gp${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["users", "customers", "capture_records", "opportunities", "tasks", "audit_logs", "domain_events", "master_data_options", "resorts", "sales_campaigns", "commercial_project_settings"]) {
      await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    }
    const url = new URL(integrationUrl!); url.pathname = `/${scratch}`;
    process.env.DATABASE_URL = url.toString();
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 6 }); db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(import.meta.dirname, "../migrations/proposed/PROPOSED_0087_capture_guestpass_links.sql"), "utf8");
    expect(sql.match(/FOREIGN KEY/g)).toHaveLength(2);
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    [{ id: userId }] = await db.insert(users).values({ openId: `gp-${runId}`, name: "Vendedor SYN", role: "seller" }).$returningId();
    guestpass = createServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization });
      const id = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
      const send = (status: number, body?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${KEY}` || mode === "unauthorized") return send(401, { code: "UNAUTHORIZED" });
      if (mode === "missing") return send(404);
      const body = { contractVersion: 1, guestPassId: id, status: "confirmed", visitDate: "2026-10-02", origin: { captorId: "cap-syn", pointId: "PONTA-NEGRA", channel: "rua" }, couple: { primaryName: "SYN Ana Prefill", secondaryName: "SYN Bruno Prefill", phone, cityUf: "Natal/RN", lodging: "Hotel SYN" }, guestPassConsentVersion: "v-syn" };
      send(200, mode === "forbidden" ? { ...body, cpf: "00000000000" } : body);
    });
    await new Promise<void>(resolve => guestpass.listen(0, "127.0.0.1", resolve));
    process.env.GUESTPASS_CRM_BASE_URL = `http://127.0.0.1:${(guestpass.address() as AddressInfo).port}`;
    process.env.GUESTPASS_CRM_READ_KEY = KEY;
  });
  afterAll(async () => { process.env = previousEnv; await new Promise(resolve => guestpass?.close(resolve)); await pool?.end(); if (scratch) await admin?.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await admin?.end(); });
  beforeEach(reset);

  it("a 0087 impõe 1 passe : 1 ficha (unique), formato do passe (CHECK) e FK da ficha", async () => {
    const a = await newCapture(); const b = await newCapture(); const pass = newPass();
    await db.insert(captureGuestpassLinks).values({ captureId: a.id, guestpassPassRef: pass });
    await expect(db.insert(captureGuestpassLinks).values({ captureId: b.id, guestpassPassRef: pass })).rejects.toBeTruthy();
    await expect(db.insert(captureGuestpassLinks).values({ captureId: a.id, guestpassPassRef: newPass() })).rejects.toBeTruthy();
    await expect(db.insert(captureGuestpassLinks).values({ captureId: b.id, guestpassPassRef: "GP-xyz" })).rejects.toBeTruthy();
    await expect(db.insert(captureGuestpassLinks).values({ captureId: 999_999_999, guestpassPassRef: newPass() })).rejects.toBeTruthy();
  });

  it("guestpass.link: vincula, repetir é no-op, passe de outra ficha e ficha com outro passe dão CONFLICT; auditoria sem dado do casal", async () => {
    const api = await caller(); const a = await newCapture(`SYN Nome Sigiloso ${runId}`, "84977770001"); const b = await newCapture(); const pass = newPass();
    expect(await api.guestpass.link({ captureId: a.id, passRef: pass.toLowerCase() })).toMatchObject({ created: true });
    expect(await api.guestpass.link({ captureId: a.id, passRef: pass })).toMatchObject({ created: false });
    await expect(api.guestpass.link({ captureId: b.id, passRef: pass })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(api.guestpass.link({ captureId: a.id, passRef: newPass() })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(api.guestpass.link({ captureId: a.id, passRef: "GP-123" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db.select().from(captureGuestpassLinks).where(eq(captureGuestpassLinks.captureId, a.id))).toHaveLength(1);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, String(a.id)));
    const linked = audits.filter(row => row.action === "guestpass_linked");
    expect(linked).toHaveLength(1);
    expect(JSON.stringify(linked)).toContain(pass);
    expect(JSON.stringify(linked)).not.toMatch(/Sigiloso|8497777/);
  });

  it("flag desligada: link e lookup recusam (PRECONDITION_FAILED) e não gravam nem chamam o GuestPass", async () => {
    const api = await caller(); const a = await newCapture(); process.env.CRM_GUESTPASS_PREFILL_ENABLED = "false";
    await expect(api.guestpass.link({ captureId: a.id, passRef: newPass() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(api.guestpass.lookup({ passRef: newPass() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await api.guestpass.status()).toEqual({ enabled: false, configured: false });
    expect(await db.select().from(captureGuestpassLinks).where(eq(captureGuestpassLinks.captureId, a.id))).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("perfil sem papel comercial (serviço) não busca nem vincula", async () => {
    const api = await caller("service");
    await expect(api.guestpass.lookup({ passRef: newPass() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.guestpass.link({ captureId: 1, passRef: newPass() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(seen).toHaveLength(0);
  });

  it("lookup: preenche os campos, usa a chave de ponte, sugere ficha existente pelo telefone e NÃO grava nada", async () => {
    const api = await caller(); phone = "(84) 98888-0007";
    const existing = await newCapture(`SYN Casal Existente ${runId}`, "84988880007");
    const other = await newCapture(`SYN Outro ${runId}`, "84911110007");
    const linkedAlready = await newCapture(`SYN Já Ligado ${runId}`, "+55 84 98888-0007");
    await db.insert(captureGuestpassLinks).values({ captureId: linkedAlready.id, guestpassPassRef: newPass() });
    const pass = newPass(); const before = (await db.select().from(captureRecords)).length;
    const result = await api.guestpass.lookup({ passRef: pass.toLowerCase() });
    expect(result.fields).toMatchObject({ fullName: "SYN Ana Prefill", partnerName: "SYN Bruno Prefill", phone, city: "Natal", state: "RN", lodgingLocation: "Hotel SYN" });
    const ids = result.candidates.map(item => item.captureId);
    expect(ids).toContain(existing.id); expect(ids).not.toContain(other.id);
    expect(result.candidates.find(item => item.captureId === linkedAlready.id)).toMatchObject({ alreadyLinked: true });
    expect(result.linkedCaptureId).toBeNull();
    expect(seen).toEqual([{ url: `/api/integrations/crm/prefill/${pass}`, auth: `Bearer ${KEY}` }]);
    expect((await db.select().from(captureRecords)).length).toBe(before);
    expect(await db.select().from(captureGuestpassLinks).where(eq(captureGuestpassLinks.guestpassPassRef, pass))).toHaveLength(0);
    // com o passe já vinculado, o lookup avisa a ficha
    await api.guestpass.link({ captureId: existing.id, passRef: pass });
    expect((await api.guestpass.lookup({ passRef: pass })).linkedCaptureId).toBe(existing.id);
  });

  it("lookup: passe inexistente, chave recusada e resposta com campo proibido viram erro claro e nada é gravado", async () => {
    const api = await caller(); phone = "84900000001";
    mode = "missing"; await expect(api.guestpass.lookup({ passRef: newPass() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    mode = "unauthorized"; await expect(api.guestpass.lookup({ passRef: newPass() })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    mode = "forbidden"; await expect(api.guestpass.lookup({ passRef: newPass() })).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    await expect(api.guestpass.lookup({ passRef: "../etc/passwd" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("captures.create com o passe: a ficha nasce vinculada, na mesma transação; mesmo passe na segunda ficha = CONFLICT e a segunda ficha NÃO é criada", async () => {
    const api = await caller(); const pass = newPass(); const first = captureInput({ guestpassPassRef: pass.toLowerCase() });
    const created = await api.captures.create(first as never);
    const [link] = await db.select().from(captureGuestpassLinks).where(eq(captureGuestpassLinks.guestpassPassRef, pass));
    expect(link).toMatchObject({ captureId: created.captureId });
    const second = captureInput({ guestpassPassRef: pass });
    const capturesBefore = (await db.select().from(captureRecords)).length;
    await expect(api.captures.create(second as never)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.select().from(captureRecords)).length).toBe(capturesBefore);
    expect(await db.select().from(customers).where(eq(customers.fullName, (second.customer as { fullName: string }).fullName))).toHaveLength(0);
  });

  it("captures.create: passe inválido ou flag desligada recusa a ficha inteira (nada gravado); sem passe, segue como sempre", async () => {
    const api = await caller(); const before = (await db.select().from(captureRecords)).length;
    await expect(api.captures.create(captureInput({ guestpassPassRef: "GP-123" }) as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    process.env.CRM_GUESTPASS_PREFILL_ENABLED = "false";
    await expect(api.captures.create(captureInput({ guestpassPassRef: newPass() }) as never)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db.select().from(captureRecords)).length).toBe(before);
    await api.captures.create(captureInput() as never);
    expect((await db.select().from(captureRecords)).length).toBe(before + 1);
  });
});
