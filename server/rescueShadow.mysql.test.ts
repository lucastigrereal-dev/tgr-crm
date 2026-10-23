import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, contractRescueAttempts, contractRescueCases, contracts, domainEvents, installmentRenegotiations, installments, salesCommissions, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { currentRetentionSettings, dismissRescueCase, recordRescueAttempt, runRescueSweep, saveRetentionSettings } from "./rescueShadow";

// F3.1 em MySQL real e DESCARTÁVEL: a migration PROPOSTA 0086 inteira (menos nada) é aplicada num banco de teste isolado; dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const T0 = new Date("2026-10-23T12:00:00Z");
const day = (offset: number) => new Date(T0.getTime() + offset * 86_400_000);
const iso = (value: Date) => value.toISOString().slice(0, 10);

describe.skipIf(!integrationUrl)("resgate/distrato em modo sombra (0086 PROPOSTA em banco descartável)", () => {
  let admin: mysql.Pool; let pool: mysql.Pool; let db: ReturnType<typeof drizzle>; let scratch = ""; let adminId = 0; let serviceId = 0;
  let seq = 0;
  const previousEnv = { ...process.env }; const flag = ENV.rescueQueueEnabled;
  const api = async (role: "admin" | "service" | "seller", id: number) => (await import("./routers/rescue")).rescueRouter.createCaller({ user: { id, role } } as never);

  beforeAll(async () => {
    const { database } = validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    scratch = `${database.replace(/_test$/i, "")}_rs${runId}_test`;
    admin = mysql.createPool({ uri: integrationUrl, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const table of ["users", "audit_logs", "domain_events", "contracts", "installments", "installment_renegotiations", "sales_commissions", "contract_cancellation_requests"]) await admin.query(`CREATE TABLE \`${scratch}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
    const url = new URL(integrationUrl!); url.pathname = `/${scratch}`;
    process.env.DATABASE_URL = url.toString();
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 6 }); db = drizzle({ client: pool });
    const sql = readFileSync(path.resolve(__dirname, "../migrations/proposed/PROPOSED_0086_rescue_and_auto_cancellation.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    [{ id: adminId }] = await db.insert(users).values({ openId: `rs-a-${runId}`, name: "Admin SYN", role: "admin" }).$returningId();
    [{ id: serviceId }] = await db.insert(users).values({ openId: `rs-s-${runId}`, name: "Pos SYN", role: "service" }).$returningId();
    ENV.rescueQueueEnabled = true;
  });
  afterAll(async () => { ENV.rescueQueueEnabled = flag; process.env = previousEnv; await pool?.end(); if (scratch) await admin?.query(`DROP DATABASE IF EXISTS \`${scratch}\``); await admin?.end(); });

  async function contract(opts: { overdueDaysAgo?: number[]; paidAmounts?: number[]; status?: "active" | "overdue" | "cancelled"; total?: string } = {}) {
    const n = ++seq;
    const [{ id }] = await db.insert(contracts).values({ number: `RS-${runId}-${n}`, customerId: 1, status: opts.status ?? "active", totalAmount: opts.total ?? "10000.00" } as never).$returningId();
    let sequence = 0;
    for (const ago of opts.overdueDaysAgo ?? []) await db.insert(installments).values({ contractId: id, sequence: ++sequence, dueDate: iso(day(-ago)) as never, amount: "1000.00", status: "open" } as never);
    for (const paid of opts.paidAmounts ?? []) await db.insert(installments).values({ contractId: id, sequence: ++sequence, dueDate: iso(day(-400)) as never, amount: String(paid), paidAmount: String(paid), status: "paid" } as never);
    return id;
  }
  const casesOf = (contractId: number) => db.select().from(contractRescueCases).where(eq(contractRescueCases.contractId, contractId));
  const eventsOf = (name: string, aggregateId: string | number) => db.select().from(domainEvents).where(eq(domainEvents.eventName, name as never)).then(rows => rows.filter(row => row.aggregateId === String(aggregateId)));
  const noSideEffects = async (contractId: number, before: { status: string; installments: number }) => {
    const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
    expect(c!.status).toBe(before.status);
    expect((await db.select().from(installments).where(eq(installments.contractId, contractId))).filter(i => i.status === "cancelled")).toHaveLength(0);
    const [{ n }] = (await pool.query("SELECT COUNT(*) AS n FROM contract_cancellation_requests WHERE contractId = ?", [contractId]))[0] as Array<{ n: number }>;
    expect(Number(n)).toBe(0);
  };

  it("abre UM caso pela primeira parcela vencida e não paga; reexecutar e rodar em paralelo não duplica caso nem evento", async () => {
    const id = await contract({ overdueDaysAgo: [40, 10] });
    await Promise.all([runRescueSweep(db, { now: T0 }), runRescueSweep(db, { now: T0 }), runRescueSweep(db, { now: T0 })]);
    await runRescueSweep(db, { now: T0 });
    const cases = await casesOf(id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ status: "open", reason: "overdue", activeKey: `rescue:${id}` });
    expect(iso(new Date(cases[0]!.rescueDueAt))).toBe("2026-12-13"); // 40 dias antes de 23/10 = 13/09; +3 meses = 13/12
  }, 20_000);

  it("prazo do caso aberto vem da primeira parcela vencida (13/09 + 3 meses = 13/12)", async () => {
    const id = await contract({ overdueDaysAgo: [40] });
    await runRescueSweep(db, { now: T0 });
    const [row] = await casesOf(id);
    expect(iso(new Date(row!.rescueDueAt))).toBe("2026-12-13");
    const [event] = await eventsOf("contract.rescue.opened", row!.id);
    expect(JSON.parse(event!.payload!)).toEqual({ caseId: Number(row!.id), contractId: id, firstOverdueDate: "2026-09-13", rescueDueAt: "2026-12-13T00:00:00.000Z" });
  });

  it("parcela paga antes do prazo: caso vira 'rescued' sozinho, libera a chave e emite o evento uma vez", async () => {
    const id = await contract({ overdueDaysAgo: [20] });
    await runRescueSweep(db, { now: T0 });
    await db.update(installments).set({ status: "paid", paidAmount: "1000.00" }).where(eq(installments.contractId, id));
    await runRescueSweep(db, { now: T0 }); await runRescueSweep(db, { now: T0 });
    const [row] = await casesOf(id);
    expect(row).toMatchObject({ status: "rescued", activeKey: null });
    expect(await eventsOf("contract.rescue.resolved", row!.id)).toHaveLength(1);
  });

  it("alerta de 'vai vencer' entra na janela configurada, uma vez só", async () => {
    const id = await contract({ overdueDaysAgo: [88] }); // vence em ~2 dias (3 meses desde 27/07 = 27/10)
    await runRescueSweep(db, { now: T0 }); await runRescueSweep(db, { now: T0 });
    const [row] = await casesOf(id);
    expect(await eventsOf("contract.rescue.due_soon", row!.id)).toHaveLength(1);
  });

  it("PRAZO VENCIDO com distrato automático DESLIGADO: caso fica 'due_for_cancellation' para decisão humana; nada é cancelado nem pedido", async () => {
    const id = await contract({ overdueDaysAgo: [120] });
    await runRescueSweep(db, { now: T0 });
    await runRescueSweep(db, { now: day(1) });
    const [row] = await casesOf(id);
    expect(row!.status).toBe("due_for_cancellation");
    expect(await eventsOf("contract.auto_cancellation.would_run", row!.id)).toHaveLength(0);
    await noSideEffects(id, { status: "active", installments: 1 });
  });

  describe("com o ensaio ligado na configuração (registra o que FARIA, nunca age)", () => {
    beforeAll(async () => { await saveRetentionSettings(db, adminId, { rescueWindowMonths: 3, rescueAlertLeadDays: 15, autoCancelEnabled: true, rescueReopenAfterDays: 90, autoCancelPromiseDays: 15, autoCancelMaxPaidPercent: 30, note: "ensaio" }); });

    it("sem teto violado: registra 'teria distratado' uma vez, com ids e percentual, e NADA é cancelado", async () => {
      const id = await contract({ overdueDaysAgo: [120], paidAmounts: [1000] });
      await runRescueSweep(db, { now: T0 }); await runRescueSweep(db, { now: T0 }); await runRescueSweep(db, { now: day(1) });
      const [row] = await casesOf(id);
      expect(row!.status).toBe("due_for_cancellation");
      const events = await eventsOf("contract.auto_cancellation.would_run", row!.id);
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload!);
      expect(payload).toMatchObject({ caseId: Number(row!.id), contractId: id, paidPercent: 10 });
      expect(JSON.stringify(payload)).not.toMatch(/name|phone|cpf/i);
      await noSideEffects(id, { status: "active", installments: 2 });
    });

    it("comissão já paga: vai para revisão manual (paid_commission), não 'teria rodado'", async () => {
      const id = await contract({ overdueDaysAgo: [120] });
      await db.insert(salesCommissions).values({ sellerId: adminId, contractId: id, baseAmount: "100.00", rate: "5.00", amount: "5.00", status: "paid" } as never);
      await runRescueSweep(db, { now: T0 }); await runRescueSweep(db, { now: day(1) });
      const [row] = await casesOf(id);
      expect(row).toMatchObject({ status: "manual_review", manualReviewReason: "paid_commission" });
      expect(await eventsOf("contract.auto_cancellation.would_run", row!.id)).toHaveLength(0);
      await noSideEffects(id, { status: "active", installments: 1 });
    });

    it("renegociação aberta, promessa recente e valor pago acima do teto barram, cada um com o seu motivo", async () => {
      const reneg = await contract({ overdueDaysAgo: [120] });
      await db.insert(installmentRenegotiations).values({ contractId: reneg, originalInstallmentId: 1, originalAmount: "1000.00", proposedAmount: "900.00", proposedDueDate: "2026-11-01" as never, status: "draft" });
      const promise = await contract({ overdueDaysAgo: [120] });
      const heavy = await contract({ overdueDaysAgo: [120], paidAmounts: [4000] });
      await runRescueSweep(db, { now: T0 });
      const [promiseCase] = await casesOf(promise);
      await recordRescueAttempt(db, serviceId, { caseId: Number(promiseCase!.id), channel: "phone", outcome: "promised_payment" }, day(0));
      await runRescueSweep(db, { now: day(1) });
      expect((await casesOf(reneg))[0]).toMatchObject({ status: "manual_review", manualReviewReason: "open_renegotiation" });
      expect((await casesOf(promise))[0]).toMatchObject({ status: "manual_review", manualReviewReason: "recent_promise" });
      expect((await casesOf(heavy))[0]).toMatchObject({ status: "manual_review", manualReviewReason: "over_cap" });
    });

    it("o caso em revisão manual nunca é reavaliado pela varredura (estado persistido)", async () => {
      const id = await contract({ overdueDaysAgo: [120] });
      await db.insert(salesCommissions).values({ sellerId: adminId, contractId: id, baseAmount: "100.00", rate: "5.00", amount: "5.00", status: "paid" } as never);
      await runRescueSweep(db, { now: T0 }); await runRescueSweep(db, { now: day(1) });
      await db.delete(salesCommissions).where(eq(salesCommissions.contractId, id));
      await runRescueSweep(db, { now: day(2) });
      const [row] = await casesOf(id);
      expect(row!.status).toBe("manual_review");
      expect(await eventsOf("contract.auto_cancellation.would_run", row!.id)).toHaveLength(0);
    });
  });

  it("tentativa do pós-vendas: open -> in_contact, evento sem nota nem dado pessoal; caso fechado recusa", async () => {
    const id = await contract({ overdueDaysAgo: [5] });
    await runRescueSweep(db, { now: T0 });
    const [row] = await casesOf(id);
    const out = await recordRescueAttempt(db, serviceId, { caseId: Number(row!.id), channel: "message", outcome: "no_answer", note: "Ligou para 11999990000" });
    expect(out.ok).toBe(true);
    expect((await casesOf(id))[0]).toMatchObject({ status: "in_contact" });
    const [event] = await eventsOf("contract.rescue.attempted", row!.id);
    expect(JSON.parse(event!.payload!)).toEqual({ caseId: Number(row!.id), contractId: id, attemptId: expect.any(Number), outcome: "no_answer" });
    expect(event!.payload).not.toMatch(/11999990000|Ligou/);
    await dismissRescueCase(db, serviceId, { caseId: Number(row!.id), note: "titular pediu" });
    expect(await recordRescueAttempt(db, serviceId, { caseId: Number(row!.id), channel: "phone", outcome: "other" })).toEqual({ ok: false, error: "NOT_OPEN" });
    expect(await db.select().from(contractRescueAttempts).where(eq(contractRescueAttempts.caseId, row!.id))).toHaveLength(1);
  });

  it("encerrar (dismissed) suprime a reabertura: o sweep não recria o caso com a mesma parcela; parcela NOVA vencida reabre; passado o prazo reabre", async () => {
    const id = await contract({ overdueDaysAgo: [30] });
    await runRescueSweep(db, { now: T0 });
    const [first] = await casesOf(id);
    await dismissRescueCase(db, adminId, { caseId: Number(first!.id), note: "negociado por fora" }, T0);
    await runRescueSweep(db, { now: day(1) }); await runRescueSweep(db, { now: day(10) });
    expect(await casesOf(id)).toHaveLength(1);
    await db.insert(installments).values({ contractId: id, sequence: 99, dueDate: iso(day(5)) as never, amount: "1000.00", status: "open" } as never);
    await runRescueSweep(db, { now: day(10) });
    const afterNew = await casesOf(id);
    expect(afterNew).toHaveLength(2);
    expect(afterNew.filter(c => c.activeKey)).toHaveLength(1);

    const later = await contract({ overdueDaysAgo: [30] });
    await runRescueSweep(db, { now: T0 });
    const [c1] = await casesOf(later);
    await dismissRescueCase(db, adminId, { caseId: Number(c1!.id), note: "teste prazo" }, T0);
    await runRescueSweep(db, { now: day(91) });
    expect(await casesOf(later)).toHaveLength(2);
  });

  it("contrato distratado por outra via (manual) fecha o caso como 'cancelled'; o resgate não participa do distrato", async () => {
    const id = await contract({ overdueDaysAgo: [30] });
    await runRescueSweep(db, { now: T0 });
    await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, id));
    await runRescueSweep(db, { now: T0 });
    expect((await casesOf(id))[0]).toMatchObject({ status: "cancelled", activeKey: null });
  });

  it("contrato já cancelado ou sem parcela vencida não abre caso", async () => {
    const cancelled = await contract({ overdueDaysAgo: [30], status: "cancelled" });
    const clean = await contract({ paidAmounts: [500] });
    await runRescueSweep(db, { now: T0 });
    expect(await casesOf(cancelled)).toHaveLength(0);
    expect(await casesOf(clean)).toHaveLength(0);
  });

  it("configuração versionada: sem linha vale o padrão; salvar grava versão, auditoria e histórico; casos abertos mantêm o prazo", async () => {
    const before = await currentRetentionSettings(db);
    expect(before.provisional).toBe(true);
    const id = await contract({ overdueDaysAgo: [10] });
    await runRescueSweep(db, { now: T0 });
    const [opened] = await casesOf(id);
    const saved = await saveRetentionSettings(db, adminId, { ...before, rescueWindowMonths: 6, note: "mudança de prazo" });
    expect((await currentRetentionSettings(db)).rescueWindowMonths).toBe(6);
    await runRescueSweep(db, { now: day(1) });
    expect((await casesOf(id))[0]!.rescueDueAt).toEqual(opened!.rescueDueAt);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, String(saved.versionId)));
    expect(audits.some(a => a.entityType === "retention_settings" && a.actorUserId === adminId)).toBe(true);
    await saveRetentionSettings(db, adminId, { ...before, rescueWindowMonths: 3, note: "volta" });
  });

  it("rotas: fila é do pós-vendas e do admin; configuração e 'teria feito' só do admin; vendedor nada; flag desligada recusa", async () => {
    const [{ id: sellerId }] = await db.insert(users).values({ openId: `rs-v-${runId}`, name: "Vend SYN", role: "seller" }).$returningId();
    expect(Array.isArray(await (await api("service", serviceId)).queue())).toBe(true);
    expect(Array.isArray(await (await api("admin", adminId)).queue())).toBe(true);
    await expect((await api("seller", sellerId)).queue()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await api("service", serviceId)).settings()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await api("service", serviceId)).shadow()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await api("service", serviceId)).saveSettings({ ...(await currentRetentionSettings(db)), rescueWindowMonths: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const adminApi = await api("admin", adminId);
    expect((await adminApi.settings()).current.rescueWindowMonths).toBeGreaterThan(0);
    expect(Array.isArray(await adminApi.shadow())).toBe(true);
    await expect(adminApi.saveSettings({ rescueWindowMonths: 99, rescueAlertLeadDays: 1, autoCancelEnabled: false, rescueReopenAfterDays: 1, autoCancelPromiseDays: 1, autoCancelMaxPaidPercent: 1 })).rejects.toBeTruthy();
    ENV.rescueQueueEnabled = false;
    await expect(adminApi.queue()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(adminApi.settings()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    ENV.rescueQueueEnabled = true;
    expect(await adminApi.status()).toEqual({ enabled: true, shadowMode: true, autoCancellationAvailable: false });
  });

  it("nenhum evento do resgate carrega texto livre", async () => {
    const rows = await db.select().from(domainEvents).where(like(domainEvents.eventName, "contract.rescue.%"));
    for (const row of rows) expect(row.payload).not.toMatch(/titular|negociado|Ligou|note/);
  });
});
