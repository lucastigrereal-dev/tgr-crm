import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, commercialFractionHistory, commercialFractions, contractCancellationRequests, contracts, customers, domainEvents, financialTransactions, installments, resorts, salesCommissions, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Seção 9 (INT-04/INT-07) em MySQL REAL: o distrato preserva a venda e o histórico, e os eventos que o Financial e o Sales
// leem (`contract.status.updated`, `contract.cancellation.executed`, `commission.status.updated`, `financial.entry.created`)
// nascem na MESMA transação do distrato. A falha é injetada no banco (trigger BEFORE INSERT em domain_events só para as
// linhas deste teste), então o rollback é do MySQL, não de mock.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("distrato em MySQL real: preserva histórico e nasce junto com seus eventos (rollback, reexecução e entrega)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let contractsRouter: typeof import("./routers/contracts")["contractsRouter"];
  let adminId: number;
  const previousEnv = { ...process.env };
  const triggers: string[] = [];

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ contractsRouter } = await import("./routers/contracts"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `dist-admin-${runId}`, name: "Gerente distrato", role: "admin" }).$returningId();
  });
  afterEach(async () => { for (const name of triggers.splice(0)) await pool.query(`DROP TRIGGER IF EXISTS \`${name}\``); });
  afterAll(async () => {
    for (const name of triggers.splice(0)) await pool.query(`DROP TRIGGER IF EXISTS \`${name}\``);
    process.env = previousEnv;
    await pool?.end();
  });

  /** Contrato ativo com 1 parcela paga + 1 aberta, 1 comissão paga + 1 pendente, 1 cota vendida, 1 lançamento aberto e distrato aprovado. */
  async function seedApprovedDistrato(label: string) {
    const [seller] = await db.insert(users).values({ openId: `dist-seller-${label}-${runId}`, name: "Vendedor", role: "seller" }).$returningId();
    const [resort] = await db.insert(resorts).values({ name: `Resort distrato ${label} ${runId}` } as never).$returningId();
    const [unit] = await db.insert(units).values({ resortId: resort.id, code: `U-D-${label}` }).$returningId();
    const [customer] = await db.insert(customers).values({ fullName: `Cliente sintético distrato ${label} ${runId}`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `DIST-${label}-${runId}`, customerId: customer.id, status: "active", totalAmount: "10000.00", signedAt: new Date() }).$returningId();
    const [paid] = await db.insert(installments).values({ contractId: contract.id, sequence: 1, dueDate: new Date("2026-09-10T12:00:00Z"), amount: "1000.00", status: "paid", paidAmount: "1000.00", paidAt: new Date() }).$returningId();
    const [open] = await db.insert(installments).values({ contractId: contract.id, sequence: 2, dueDate: new Date("2026-11-10T12:00:00Z"), amount: "1000.00", status: "open", paidAmount: "0.00" }).$returningId();
    const [paidCommission] = await db.insert(salesCommissions).values({ sellerId: seller.id, contractId: contract.id, commissionRole: "closer", baseAmount: "1000.00", rate: "3.00", amount: "30.00", status: "paid", lifecycleStatus: "paid", paidAt: new Date() }).$returningId();
    const [pendingCommission] = await db.insert(salesCommissions).values({ sellerId: seller.id, contractId: contract.id, commissionRole: "liner", baseAmount: "1000.00", rate: "2.00", amount: "20.00" }).$returningId();
    const [fraction] = await db.insert(commercialFractions).values({ resortId: resort.id, unitId: unit.id, code: `F-D-${label}`, sequence: 1, status: "sold", currentContractId: contract.id, listPrice: "10000.00" }).$returningId();
    await db.insert(financialTransactions).values({ contractId: contract.id, type: "income", category: "Parcela de contrato", description: "Parcela 2 prevista", amount: "1000.00", status: "open", createdByUserId: adminId });
    const [request] = await db.insert(contractCancellationRequests).values({ contractId: contract.id, status: "approved", reason: "Cliente desistiu (sintético)", simulationSnapshot: JSON.stringify({ paidAmount: 1000, penalty: 100, refund: 50, policyConfigured: true }), requestedByUserId: adminId, decidedByUserId: adminId }).$returningId();
    return { contractId: contract.id, requestId: request.id, paidInstallmentId: paid.id, openInstallmentId: open.id, paidCommissionId: paidCommission.id, pendingCommissionId: pendingCommission.id, fractionId: fraction.id };
  }
  type Seed = Awaited<ReturnType<typeof seedApprovedDistrato>>;

  /** Recusa no banco o INSERT em domain_events que casar com `condition` (SQL sobre NEW). */
  async function failEventInsert(label: string, condition: string) {
    const name = `dist_${label}_${runId}`;
    await pool.query(`CREATE TRIGGER \`${name}\` BEFORE INSERT ON domain_events FOR EACH ROW BEGIN IF ${condition} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'distrato: falha injetada'; END IF; END`);
    triggers.push(name);
    return name;
  }
  const dropTrigger = async (name: string) => { await pool.query(`DROP TRIGGER IF EXISTS \`${name}\``); triggers.splice(triggers.indexOf(name), 1); };
  const admin = () => contractsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
  /** A recusa tem de ser a falha injetada pelo trigger (na mensagem ou na cadeia de causas), não qualquer erro do seed. */
  async function expectInjectedFailure(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).not.toBeNull();
    const chain: string[] = [];
    for (let current = error as { message?: string; cause?: unknown } | undefined; current && chain.length < 6; current = current.cause as typeof current) chain.push(String(current.message ?? current));
    expect(chain.join(" | ")).toContain("distrato: falha injetada");
  }

  async function distratoEvents(seed: Seed) {
    const byAggregate = (eventName: string, aggregateIds: number[]) => db.select().from(domainEvents).where(and(eq(domainEvents.eventName, eventName as never), inArray(domainEvents.aggregateId, aggregateIds.map(String))));
    const entryIds = (await db.select({ id: financialTransactions.id }).from(financialTransactions).where(and(eq(financialTransactions.contractId, seed.contractId), inArray(financialTransactions.category, ["Distrato · multa/retenção", "Distrato · reembolso"])))).map(row => row.id);
    return {
      contractCancelled: await byAggregate("contract.status.updated", [seed.contractId]),
      executed: await byAggregate("contract.cancellation.executed", [seed.requestId]),
      commissionCancelled: await byAggregate("commission.status.updated", [seed.pendingCommissionId]),
      reversalRequested: await byAggregate("commission.reversal_review.requested", [seed.paidCommissionId]),
      entryCreated: entryIds.length ? await byAggregate("financial.entry.created", entryIds) : [],
      fractionReturned: await byAggregate("commercial.fraction.status.changed", [seed.fractionId]),
    };
  }

  async function snapshot(seed: Seed) {
    const [contract] = await db.select().from(contracts).where(eq(contracts.id, seed.contractId));
    const [request] = await db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.id, seed.requestId));
    const schedule = await db.select().from(installments).where(eq(installments.contractId, seed.contractId));
    const commissions = await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, seed.contractId));
    const [fraction] = await db.select().from(commercialFractions).where(eq(commercialFractions.id, seed.fractionId));
    const events = await distratoEvents(seed);
    return {
      contract: { status: contract.status, cancellationReason: contract.cancellationReason },
      request: request.status,
      installments: Object.fromEntries(schedule.map(row => [row.id, { status: row.status, paidAmount: row.paidAmount }])),
      commissions: Object.fromEntries(commissions.map(row => [row.id, { status: row.status, reversalReviewStatus: row.reversalReviewStatus }])),
      fraction: { status: fraction.status, currentContractId: fraction.currentContractId },
      fractionHistory: (await db.select().from(commercialFractionHistory).where(eq(commercialFractionHistory.fractionId, seed.fractionId))).map(row => [row.fromStatus, row.toStatus, row.contractId]),
      transactions: (await db.select().from(financialTransactions).where(eq(financialTransactions.contractId, seed.contractId))).map(row => [row.category, row.status]).sort(),
      executedAudits: (await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "contract_cancellation_request"), eq(auditLogs.entityId, String(seed.requestId)), eq(auditLogs.action, "executed")))).length,
      eventCounts: Object.fromEntries(Object.entries(events).map(([key, rows]) => [key, rows.length])),
    };
  }

  it("falha ao gravar contract.cancellation.executed desfaz o distrato inteiro; reexecutar grava tudo uma vez só e preserva a venda", async () => {
    const seed = await seedApprovedDistrato("exec");
    const before = await snapshot(seed);
    const trigger = await failEventInsert("exec", `NEW.eventName = 'contract.cancellation.executed' AND NEW.aggregateId = '${seed.requestId}'`);
    await expectInjectedFailure(admin().executeCancellation({ requestId: seed.requestId }));
    // Nada mudou: nem o contrato, nem parcelas, comissões, cota, lançamentos, auditoria ou o evento do status (gravado antes da falha).
    expect(await snapshot(seed)).toEqual(before);
    expect(before.contract.status).toBe("active");

    await dropTrigger(trigger);
    await expect(admin().executeCancellation({ requestId: seed.requestId })).resolves.toMatchObject({ success: true, cancelledInstallments: 1, cancelledCommissions: 1, financialEntries: 2, returnedFractionIds: [seed.fractionId] });
    const after = await snapshot(seed);
    // INT-04: o contrato continua existindo (cancelado, com motivo), o que foi pago fica pago, a comissão paga não é estornada.
    expect(after.contract).toEqual({ status: "cancelled", cancellationReason: "Cliente desistiu (sintético)" });
    expect(after.request).toBe("executed");
    expect(after.installments[seed.paidInstallmentId]).toEqual({ status: "paid", paidAmount: "1000.00" });
    expect(after.installments[seed.openInstallmentId]).toMatchObject({ status: "cancelled" });
    expect(after.commissions[seed.paidCommissionId]).toEqual({ status: "paid", reversalReviewStatus: "pending" });
    expect(after.commissions[seed.pendingCommissionId]).toMatchObject({ status: "cancelled" });
    expect(after.fraction).toEqual({ status: "available", currentContractId: null });
    expect(after.fractionHistory).toEqual([["sold", "available", seed.contractId]]);
    expect(after.transactions).toEqual([["Distrato · multa/retenção", "open"], ["Distrato · reembolso", "open"], ["Parcela de contrato", "cancelled"]]);
    expect(after.executedAudits).toBe(1);
    expect(after.eventCounts).toEqual({ contractCancelled: 1, executed: 1, commissionCancelled: 1, reversalRequested: 1, entryCreated: 2, fractionReturned: 1 });

    // Reexecutar o mesmo distrato é recusado e não acrescenta nada.
    await expect(admin().executeCancellation({ requestId: seed.requestId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot(seed)).toEqual(after);
  });

  it("falha ao gravar financial.entry.created (no meio do laço) também desfaz tudo, inclusive os eventos já inseridos; depois grava uma vez só", async () => {
    const seed = await seedApprovedDistrato("entry");
    const before = await snapshot(seed);
    const trigger = await failEventInsert("entry", `NEW.eventName = 'financial.entry.created' AND NEW.payload LIKE '%"contractId":${seed.contractId},%'`);
    await expectInjectedFailure(admin().executeCancellation({ requestId: seed.requestId }));
    expect(await snapshot(seed)).toEqual(before);
    await dropTrigger(trigger);
    await expect(admin().executeCancellation({ requestId: seed.requestId })).resolves.toMatchObject({ success: true, financialEntries: 2 });
    expect((await snapshot(seed)).eventCounts).toEqual({ contractCancelled: 1, executed: 1, commissionCancelled: 1, reversalRequested: 1, entryCreated: 2, fractionReturned: 1 });
  });

  it("entrega: os eventos do distrato ficam na fila do Financial com envelope válido (a entrega ao Sales do commit tardio é provada em bridgeLateCommit.mysql)", async () => {
    const seed = await seedApprovedDistrato("delivery");
    await admin().executeCancellation({ requestId: seed.requestId });
    const events = await distratoEvents(seed);
    const financialRows = [...events.contractCancelled, ...events.executed, ...events.commissionCancelled, ...events.entryCreated];
    expect(financialRows).toHaveLength(5);
    const { FINANCIAL_EVENT_NAMES, financialBridgeEnvelope } = await import("./financialBridge");
    const project = { externalKey: randomUUID(), name: `SYN distrato ${runId}`, timezone: "America/Recife" };
    for (const row of financialRows) {
      expect(FINANCIAL_EVENT_NAMES).toContain(row.eventName);
      const envelope = financialBridgeEnvelope(row, project);
      expect(String(envelope.event.eventId)).toBe(String(row.id));
      expect(envelope.correlationId).toBe(`crm-fin-${row.id}`);
    }
    expect(events.contractCancelled[0]).toMatchObject({ idempotencyKey: `contract-cancelled:${seed.contractId}:${seed.requestId}` });
    expect(JSON.parse(String(events.contractCancelled[0].payload))).toMatchObject({ status: "cancelled" });
  });
});
