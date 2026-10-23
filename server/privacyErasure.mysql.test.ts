import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, contracts, customerContacts, customerInteractions, customers, domainEvents, opportunities, privacyErasureEvents, privacyErasureReceipts, vouchers } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { cpfHmac, pendingSystems, processErasureEvent, recordSystemReceipt } from "./privacyErasure";
import { runErasureSync } from "./privacyErasureFeed";

// F2.10 em MySQL real e descartável: a migration PROPOSTA 0088 inteira é aplicada e removida ao final. CPFs e nomes sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const SECRET = `segredo-sintetico-${runId}`;
const cpfOf = (n: number) => String(10_000_000_000 + n * 7919 + Number.parseInt(runId.slice(0, 4), 16)).padStart(11, "0").slice(0, 11);
let seq = 0;

describe.skipIf(!integrationUrl)("exclusão LGPD propagada do GuestPass, lado CRM (0088 PROPOSTA)", () => {
  let pool: mysql.Pool; let db: ReturnType<typeof drizzle>;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 }); db = drizzle({ client: pool });
    await pool.query("DROP TABLE IF EXISTS privacy_erasure_receipts"); await pool.query("DROP TABLE IF EXISTS privacy_erasure_events");
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0088_privacy_erasure_propagation.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
  });
  afterAll(async () => { await pool?.query("DROP TABLE IF EXISTS privacy_erasure_receipts"); await pool?.query("DROP TABLE IF EXISTS privacy_erasure_events"); process.env = previousEnv; await pool?.end(); });

  async function seed(label: string, opts: { cpf?: string; contract?: boolean } = {}) {
    const cpf = opts.cpf ?? cpfOf(++seq);
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Propagado ${label} ${runId}`, documentNumber: cpf, email: `${label}@exemplo.test`, phone: "11911112222", city: "Natal", notes: "obs pessoal", status: "active" } as never).$returningId();
    await db.insert(customerContacts).values({ customerId, kind: "phone", value: "11933334444" });
    await db.insert(customerInteractions).values({ customerId, type: "note", subject: "Assunto", content: "Conversa pessoal" });
    await db.insert(opportunities).values({ customerId, title: `Oportunidade de ${label}`, lossReason: "motivo pessoal" } as never);
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId, coupleCode: `PRP-${label}-${runId}`, salesRoom: "Sala", partnerName: "Cônjuge Sintético", notes: "obs", averageIncome: "9000.00" } as never).$returningId();
    await db.insert(vouchers).values({ code: `P${label}${runId}`.slice(0, 16), customerId, captureId, description: "Jantar", issuedAt: new Date("2026-10-10T15:00:00Z"), redeemNote: "nota pessoal" });
    if (opts.contract) await db.insert(contracts).values({ number: `PRP-${label}-${runId}`, customerId, status: "active", totalAmount: "1000.00" } as never);
    return { customerId, captureId, cpf };
  }
  const event = (cpf: string, over: Record<string, unknown> = {}) => ({ contractVersion: 1, eventId: `evt-${randomUUID()}`, type: "privacy.erasure.requested.v1", guestPassId: "GP-SYNTH", requestId: 5, mode: "minimal", keep: ["name", "cpf", "benefitDate"], requestedAt: "2026-10-23T12:00:00Z", fulfilledAt: "2026-10-23T12:05:00Z", subjectRefs: { cpfHmac: cpfHmac(cpf, SECRET) }, ...over });
  const customerOf = async (id: number) => (await db.select().from(customers).where(eq(customers.id, id)))[0]!;

  it("minimal: anonimiza só o CRM do titular (fica nome, CPF e a data do brinde), recibo 'done', evento interno sem PII, trilha sem CPF/HMAC", async () => {
    const a = await seed("a"); const other = await seed("b");
    const ev = event(a.cpf);
    const result = await processErasureEvent(db, ev, { hmacSecret: SECRET });
    expect(result).toMatchObject({ replay: false, status: "done", receipt: { system: "crm", status: "done" } });
    const c = await customerOf(a.customerId);
    expect(c).toMatchObject({ fullName: `Casal Propagado a ${runId}`, documentNumber: a.cpf, email: null, phone: null, city: null, notes: null, status: "inactive" });
    expect(c.anonymizedAt).toBeInstanceOf(Date);
    expect(await db.select().from(customerContacts).where(eq(customerContacts.customerId, a.customerId))).toHaveLength(0);
    expect((await db.select().from(captureRecords).where(eq(captureRecords.id, a.captureId)))[0]).toMatchObject({ partnerName: null, notes: null, averageIncome: null });
    expect((await db.select().from(vouchers).where(eq(vouchers.customerId, a.customerId)))[0]).toMatchObject({ redeemNote: null, issuedAt: new Date("2026-10-10T15:00:00Z") }); // data do brinde fica
    // Outro titular intacto.
    expect(await customerOf(other.customerId)).toMatchObject({ email: "b@exemplo.test", anonymizedAt: null });
    // Estado do evento: HMAC apagado ao terminar; recibo gravado; evento interno único e sem PII.
    const [row] = await db.select().from(privacyErasureEvents).where(eq(privacyErasureEvents.eventId, ev.eventId));
    expect(row).toMatchObject({ status: "done", cpfHmac: null, customersMatched: 1, customersAnonymized: 1 });
    const events = await db.select().from(domainEvents).where(eq(domainEvents.eventName, "privacy.erasure.requested" as never));
    const mine = events.filter(e => e.idempotencyKey === `privacy-erasure:${ev.eventId}`);
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0]!.payload!)).toEqual({ eventId: ev.eventId, mode: "minimal" });
    const trail = JSON.stringify(await db.select().from(auditLogs).where(inArray(auditLogs.entityType, ["privacy_erasure", "customer"])));
    expect(trail).not.toContain(a.cpf); expect(trail).not.toContain(cpfHmac(a.cpf, SECRET)!); expect(trail).not.toMatch(/@exemplo\.test|Cônjuge/);
    // Faltam os recibos dos outros sistemas (o pedido só é 'propagado' com todos).
    expect(await pendingSystems(db, ev.eventId)).toEqual(["sales", "recovery", "relationship", "financial"]);
    expect(await recordSystemReceipt(db, { eventId: ev.eventId, system: "sales", status: "nothing_to_erase" })).toEqual({ ok: true });
    expect(await recordSystemReceipt(db, { eventId: "evt-desconhecido", system: "sales", status: "done" })).toEqual({ ok: false, error: "UNKNOWN_EVENT" });
    expect(await pendingSystems(db, ev.eventId)).toEqual(["recovery", "relationship", "financial"]);
  });

  it("idempotente: o mesmo eventId (inclusive em paralelo) anonimiza uma vez e devolve o mesmo recibo; nada de evento duplicado", async () => {
    const a = await seed("idem");
    const ev = event(a.cpf);
    const results = await Promise.all([processErasureEvent(db, ev, { hmacSecret: SECRET }), processErasureEvent(db, ev, { hmacSecret: SECRET }), processErasureEvent(db, ev, { hmacSecret: SECRET })]);
    for (const r of results) expect(r.receipt.status).toBe("done");
    const again = await processErasureEvent(db, ev, { hmacSecret: SECRET });
    expect(again).toMatchObject({ replay: true, status: "done" });
    expect(await db.select().from(privacyErasureEvents).where(eq(privacyErasureEvents.eventId, ev.eventId))).toHaveLength(1);
    expect(await db.select().from(privacyErasureReceipts).where(and(eq(privacyErasureReceipts.eventId, ev.eventId), eq(privacyErasureReceipts.system, "crm")))).toHaveLength(1);
    expect((await db.select().from(domainEvents)).filter(e => e.idempotencyKey === `privacy-erasure:${ev.eventId}`)).toHaveLength(1);
  });

  it("titular que o CRM não tem: recibo 'nothing_to_erase' e nada muda", async () => {
    const bystander = await seed("by");
    const result = await processErasureEvent(db, event("99999999999"), { hmacSecret: SECRET });
    expect(result).toMatchObject({ status: "nothing_to_erase", receipt: { status: "nothing_to_erase" } });
    expect((await customerOf(bystander.customerId)).anonymizedAt).toBeNull();
  });

  it("titular já anonimizado (pedido repetido com outro eventId): 'nothing_to_erase' e detalhe, sem reanonimizar", async () => {
    const a = await seed("twice");
    await processErasureEvent(db, event(a.cpf), { hmacSecret: SECRET });
    const again = await processErasureEvent(db, event(a.cpf), { hmacSecret: SECRET });
    expect(again).toMatchObject({ status: "nothing_to_erase", receipt: { status: "nothing_to_erase", detail: "titular já anonimizado" } });
  });

  it("guarda legal (contrato): nada é apagado, recibo 'failed' com o motivo, evento fica 'needs_human' e guarda o HMAC para a decisão humana", async () => {
    const a = await seed("legal", { contract: true });
    const ev = event(a.cpf);
    const result = await processErasureEvent(db, ev, { hmacSecret: SECRET });
    expect(result).toMatchObject({ status: "needs_human", receipt: { status: "failed" } });
    expect(result.receipt.detail).toContain("tem contrato");
    expect(await customerOf(a.customerId)).toMatchObject({ email: "legal@exemplo.test", anonymizedAt: null });
    const [row] = await db.select().from(privacyErasureEvents).where(eq(privacyErasureEvents.eventId, ev.eventId));
    expect(row).toMatchObject({ status: "needs_human", customersMatched: 1, customersAnonymized: 0 });
    expect(row!.cpfHmac).toBe(cpfHmac(a.cpf, SECRET));
  });

  it("dois cadastros do mesmo CPF (um com contrato): anonimiza o livre e marca 'partial'", async () => {
    // documentNumber é único: o segundo cadastro usa o mesmo CPF com máscara, que a normalização trata como o mesmo titular.
    const free = await seed("p1");
    const masked = `${free.cpf.slice(0, 3)}.${free.cpf.slice(3, 6)}.${free.cpf.slice(6, 9)}-${free.cpf.slice(9)}`;
    const held = await seed("p2", { cpf: masked, contract: true });
    const result = await processErasureEvent(db, event(free.cpf), { hmacSecret: SECRET });
    expect(result).toMatchObject({ status: "partial", receipt: { status: "partial" } });
    expect((await customerOf(free.customerId)).anonymizedAt).toBeInstanceOf(Date);
    expect((await customerOf(held.customerId)).anonymizedAt).toBeNull();
  });

  it("modo full e mínimo legal divergente NÃO apagam nada (decisão humana)", async () => {
    const a = await seed("full"); const b = await seed("keep");
    const full = await processErasureEvent(db, event(a.cpf, { mode: "full", keep: [] }), { hmacSecret: SECRET });
    expect(full).toMatchObject({ status: "needs_human", receipt: { status: "failed" } });
    const diverge = await processErasureEvent(db, event(b.cpf, { keep: ["name"] }), { hmacSecret: SECRET });
    expect(diverge).toMatchObject({ status: "needs_human", receipt: { status: "failed" } });
    expect((await customerOf(a.customerId)).anonymizedAt).toBeNull();
    expect((await customerOf(b.customerId)).anonymizedAt).toBeNull();
  });

  it("evento fora do contrato é recusado sem gravar nada", async () => {
    const before = (await db.select().from(privacyErasureEvents)).length;
    await expect(processErasureEvent(db, { ...event("12345678909"), subjectRefs: { cpfHmac: "12345678909" } }, { hmacSecret: SECRET })).rejects.toBeTruthy();
    expect((await db.select().from(privacyErasureEvents)).length).toBe(before);
  });

  describe("feed por pull (servidor HTTP local falso)", () => {
    let server: Server; let base = ""; let mode: "ok" | "401" | "429" = "ok";
    const posted: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
    let pages: Array<{ events: unknown[]; nextCursor: string | null }> = [];
    let receiptFails = false;
    beforeAll(async () => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => {
          if (mode === "401") { res.statusCode = 401; return res.end("{}"); }
          if (mode === "429") { res.statusCode = 429; res.setHeader("retry-after", "60"); return res.end("{}"); }
          const url = new URL(req.url!, "http://x");
          if (req.method === "POST" && url.pathname.endsWith("/receipt")) {
            posted.push({ path: url.pathname, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
            res.statusCode = receiptFails ? 500 : 200; return res.end("{}");
          }
          const index = url.searchParams.get("after") ? Number(url.searchParams.get("after")) : 0;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(pages[index] ?? { events: [], nextCursor: null }));
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/integrations/privacy/erasures`;
    });
    afterAll(async () => { await new Promise(resolve => server?.close(resolve)); });
    const config = () => ({ endpoint: base, key: "chave-sintetica", hmacSecret: SECRET });

    it("busca as páginas, processa, devolve o recibo com Bearer e sem PII, e não repete recibo já entregue", async () => {
      const a = await seed("f1"); const b = await seed("f2");
      const e1 = event(a.cpf); const e2 = event(b.cpf);
      pages = [{ events: [e1], nextCursor: "1" }, { events: [e2, { lixo: true }], nextCursor: null }];
      posted.length = 0; mode = "ok"; receiptFails = false;
      const out = await runErasureSync(db, config());
      expect(out).toMatchObject({ pages: 2, received: 3, processed: 2, invalid: 1, stopped: "done" });
      expect(out.receiptsDelivered).toBeGreaterThanOrEqual(2);
      const mine = posted.filter(p => p.path.includes(e1.eventId) || p.path.includes(e2.eventId));
      expect(mine).toHaveLength(2);
      for (const p of mine) { expect(p.auth).toBe("Bearer chave-sintetica"); expect(p.body).toMatchObject({ system: "crm", status: "done" }); expect(JSON.stringify(p.body)).not.toMatch(new RegExp(`${a.cpf}|${b.cpf}|@exemplo|Casal Propagado`)); }
      const before = posted.length;
      await runErasureSync(db, config());
      expect(posted.length).toBe(before); // recibos já entregues não repetem
      expect((await db.select().from(privacyErasureReceipts).where(eq(privacyErasureReceipts.eventId, e1.eventId)))[0]!.deliveredAt).toBeInstanceOf(Date);
    });

    it("recibo que falha na entrega fica pendente e é reenviado na próxima rodada", async () => {
      const a = await seed("f3"); const e = event(a.cpf);
      pages = [{ events: [e], nextCursor: null }]; posted.length = 0; receiptFails = true;
      const first = await runErasureSync(db, config());
      expect(first.receiptsFailed).toBeGreaterThanOrEqual(1);
      expect((await db.select().from(privacyErasureReceipts).where(eq(privacyErasureReceipts.eventId, e.eventId)))[0]!.deliveredAt).toBeNull();
      receiptFails = false; pages = [];
      await runErasureSync(db, config());
      expect((await db.select().from(privacyErasureReceipts).where(eq(privacyErasureReceipts.eventId, e.eventId)))[0]!.deliveredAt).toBeInstanceOf(Date);
    });

    it("401 e 429 interrompem a rodada sem processar nada; endpoint inválido ou sem chave não faz chamada", async () => {
      pages = [{ events: [event("11111111111")], nextCursor: null }];
      mode = "401"; expect((await runErasureSync(db, config())).stopped).toBe("unauthorized");
      mode = "429"; expect((await runErasureSync(db, config())).stopped).toBe("rate_limited");
      mode = "ok";
      expect((await runErasureSync(db, { ...config(), endpoint: "http://exemplo.test/x" })).stopped).toBe("unavailable");
      expect((await runErasureSync(db, { ...config(), key: "" })).stopped).toBe("unavailable");
      expect((await runErasureSync(db, { ...config(), hmacSecret: "" })).stopped).toBe("unavailable");
    });
  });
});
