import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { billingRecords, contracts, customers, domainEvents, installmentRenegotiations, installments, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { runTriggerDdl } from "./mysqlTestDdl";

// CRM-A11 (lado CRM) em MySQL REAL: o acordo de parcela tem quem o dispare (aprovar, aplicar, encerrar) e a aplicação é atômica com o evento.
// A parte do Financial (cancelar a parcela pendente do lado dele) NÃO é testada aqui: não é nossa. Dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("CRM-A11: renegociação de parcela, aprovar e aplicar (MySQL real)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let financeRouter: typeof import("./routers/finance")["financeRouter"];
  let proposer: number;
  let approver: number;
  const previousEnv = { ...process.env };
  const triggers: string[] = [];

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ financeRouter } = await import("./routers/finance"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: proposer }] = await db.insert(users).values({ openId: `a11-proposer-${runId}`, name: "Financeiro 1", role: "finance" }).$returningId();
    [{ id: approver }] = await db.insert(users).values({ openId: `a11-approver-${runId}`, name: "Financeiro 2", role: "finance" }).$returningId();
  });
  afterEach(async () => { delete process.env.RENEGOTIATION_SELF_APPROVAL; for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); });
  afterAll(async () => { for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); process.env = previousEnv; await pool?.end(); });

  const as = (id: number) => financeRouter.createCaller({ user: { id, role: "finance" } } as never);
  async function seed(label: string) {
    const [customer] = await db.insert(customers).values({ fullName: `Cliente A11 ${label} ${runId}`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `A11-${label}-${runId}`, customerId: customer.id, status: "active", totalAmount: "3000.00" }).$returningId();
    const [inst] = await db.insert(installments).values({ contractId: contract.id, sequence: 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount: "1000.00", status: "overdue", paidAmount: "0.00" }).$returningId();
    const [billing] = await db.insert(billingRecords).values({ installmentId: inst.id, type: "pix", status: "generated", gatewayProvider: "asaas", gatewayPaymentId: `pay_a11_${label}_${runId}`, amount: "1000.00", dueDate: new Date("2026-10-10T12:00:00Z") }).$returningId();
    const { id } = await as(proposer).createRenegotiation({ installmentId: inst.id, proposedAmount: 900, proposedDueDate: "2026-12-15" });
    return { contractId: contract.id, installmentId: inst.id, billingId: billing.id, renegotiationId: id, gatewayPaymentId: `pay_a11_${label}_${runId}` };
  }
  async function failApplied(renegotiationId: number) {
    const name = `a11_fail_applied_${runId}_${renegotiationId}`;
    await runTriggerDdl(pool, `CREATE TRIGGER \`${name}\` BEFORE INSERT ON domain_events FOR EACH ROW BEGIN IF NEW.eventName = 'installment.renegotiation.applied' AND NEW.aggregateId = '${renegotiationId}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'falha injetada: renegotiation.applied'; END IF; END`);
    triggers.push(name);
  }
  const state = async (s: Awaited<ReturnType<typeof seed>>) => ({
    original: (await db.select().from(installments).where(eq(installments.id, s.installmentId)))[0]!.status,
    installments: (await db.select().from(installments).where(eq(installments.contractId, s.contractId))).length,
    billing: (await db.select().from(billingRecords).where(eq(billingRecords.id, s.billingId)))[0]!.status,
    renegotiation: (await db.select().from(installmentRenegotiations).where(eq(installmentRenegotiations.id, s.renegotiationId)))[0]!.status,
    applied: (await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "installment.renegotiation.applied" as never), eq(domainEvents.aggregateId, String(s.renegotiationId))))).length,
  });

  it("quem propôs não aprova (padrão); outro usuário aprova; só rascunho é aprovável", async () => {
    const s = await seed("aprova");
    await expect(as(proposer).approveRenegotiation({ id: s.renegotiationId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await state(s)).renegotiation).toBe("draft");
    await expect(as(approver).applyRenegotiation({ id: s.renegotiationId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(as(approver).approveRenegotiation({ id: s.renegotiationId })).resolves.toMatchObject({ status: "approved" });
    const row = (await db.select().from(installmentRenegotiations).where(eq(installmentRenegotiations.id, s.renegotiationId)))[0]!;
    expect(row.approvedByUserId).toBe(approver);
    await expect(as(approver).approveRenegotiation({ id: s.renegotiationId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("configuração libera a autoaprovação (operação de uma pessoa só)", async () => {
    process.env.RENEGOTIATION_SELF_APPROVAL = "true";
    const s = await seed("auto");
    await expect(as(proposer).approveRenegotiation({ id: s.renegotiationId })).resolves.toMatchObject({ status: "approved" });
  });

  it("aplicar: original vira renegociada, nasce a nova parcela, a cobrança aberta é cancelada, eventos saem juntos e repetir não duplica", async () => {
    const s = await seed("aplica");
    await as(approver).approveRenegotiation({ id: s.renegotiationId });
    const result = await as(approver).applyRenegotiation({ id: s.renegotiationId });
    expect(result).toMatchObject({ status: "applied", originalInstallmentId: s.installmentId, cancelledBillingIds: [s.billingId] });
    expect(await state(s)).toMatchObject({ original: "renegotiated", installments: 2, billing: "cancelled", renegotiation: "applied", applied: 1 });
    const fresh = (await db.select().from(installments).where(eq(installments.id, result.newInstallmentId)))[0]!;
    expect(fresh).toMatchObject({ sequence: 2, amount: "900.00", status: "open", paidAmount: "0.00" });
    const [event] = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "installment.renegotiation.applied" as never), eq(domainEvents.aggregateId, String(s.renegotiationId))));
    expect(JSON.parse(String(event!.payload))).toMatchObject({ installmentId: s.installmentId, newInstallmentId: result.newInstallmentId, gatewayPaymentIds: [s.gatewayPaymentId] });
    const scheduled = (await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "installment.scheduled" as never), eq(domainEvents.aggregateId, String(result.newInstallmentId)))));
    expect(scheduled).toHaveLength(1);
    await expect(as(approver).applyRenegotiation({ id: s.renegotiationId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await state(s)).toMatchObject({ installments: 2, applied: 1 });
  });

  it("ATOMICIDADE: se o evento de aplicação falha, nada muda (parcela, nova parcela, cobrança, acordo)", async () => {
    const s = await seed("atomica");
    await as(approver).approveRenegotiation({ id: s.renegotiationId });
    await failApplied(s.renegotiationId);
    await expect(as(approver).applyRenegotiation({ id: s.renegotiationId })).rejects.toThrow();
    expect(await state(s)).toMatchObject({ original: "overdue", installments: 1, billing: "generated", renegotiation: "approved", applied: 0 });
  });

  it("saldo mudou depois da proposta: recusa aplicar; parcela já paga: recusa; acordo cancelado não se aplica", async () => {
    const stale = await seed("saldo");
    await as(approver).approveRenegotiation({ id: stale.renegotiationId });
    await db.update(installments).set({ paidAmount: "100.00" }).where(eq(installments.id, stale.installmentId));
    await expect(as(approver).applyRenegotiation({ id: stale.renegotiationId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await state(stale)).toMatchObject({ original: "overdue", installments: 1, renegotiation: "approved" });

    const paid = await seed("paga");
    await as(approver).approveRenegotiation({ id: paid.renegotiationId });
    await db.update(installments).set({ status: "paid" }).where(eq(installments.id, paid.installmentId));
    await expect(as(approver).applyRenegotiation({ id: paid.renegotiationId })).rejects.toMatchObject({ code: "CONFLICT" });

    const cancelled = await seed("cancelada");
    await as(approver).approveRenegotiation({ id: cancelled.renegotiationId });
    await expect(as(approver).cancelRenegotiation({ id: cancelled.renegotiationId })).resolves.toMatchObject({ status: "cancelled" });
    await expect(as(approver).applyRenegotiation({ id: cancelled.renegotiationId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(as(approver).cancelRenegotiation({ id: cancelled.renegotiationId, reject: true })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await state(cancelled)).toMatchObject({ original: "overdue", installments: 1, billing: "generated" });
  });
});
