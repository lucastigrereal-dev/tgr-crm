import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, commercialProjectSettings, contractCancellationRequests, contractDocuments, contracts, customers, domainEvents, financialTransactions, installments, opportunities, proposals, resorts, salesCommissions, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// ADR-010 contra MySQL descartável: janela de 0% rastreável + reprocesso idempotente; fila de estorno com decisão.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("ADR-010 comissão 0% e fila de estorno em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let svc: typeof import("./saleValidationService");
  let financeRouter: typeof import("./routers/finance")["financeRouter"];
  let commissionsRouter: typeof import("./routers/commissions")["commissionsRouter"];
  let contractsRouter: typeof import("./routers/contracts")["contractsRouter"];
  let adminId: number;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    svc = await import("./saleValidationService");
    ({ financeRouter } = await import("./routers/finance"));
    ({ commissionsRouter } = await import("./routers/commissions"));
    ({ contractsRouter } = await import("./routers/contracts"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 6 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `adr10-admin-${runId}`, name: "Gerente ADR10", role: "admin" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const policy = (rates: { liner: number; closer: number; ftb: number }) => JSON.stringify({ linerRate: rates.liner, closerRate: rates.closer, ftbRate: rates.ftb, cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt" });
  const zero = policy({ liner: 0, closer: 0, ftb: 0 });
  const rated = policy({ liner: 0.02, closer: 0.03, ftb: 0.04 });

  async function seedSale(label: string, opts: { policy?: string; paidSequences?: number[]; status?: "pending_signature" | "active" } = {}) {
    const [liner] = await db.insert(users).values({ openId: `adr10-liner-${label}-${runId}`, name: "Liner", role: "seller" }).$returningId();
    const [closer] = await db.insert(users).values({ openId: `adr10-closer-${label}-${runId}`, name: "Closer", role: "seller" }).$returningId();
    const [resort] = await db.insert(resorts).values({ name: `Resort ADR10 ${label} ${runId}` } as never).$returningId();
    await db.insert(commercialProjectSettings).values({ resortId: resort.id, commissionPolicy: opts.policy ?? zero });
    const [customer] = await db.insert(customers).values({ fullName: `Cliente ADR10 ${label} ${runId}`, status: "active" }).$returningId();
    const [opportunity] = await db.insert(opportunities).values({ customerId: customer.id, title: `Opp ${label}`, sellerId: closer.id } as never).$returningId();
    const [proposal] = await db.insert(proposals).values({ opportunityId: opportunity.id, reference: `P-A10-${label}-${runId}`, productDescription: "Semana fixa", totalAmount: "10000.00", downPaymentAmount: "1000.00", installmentCount: 3 }).$returningId();
    await db.insert(captureRecords).values({ customerId: customer.id, resortId: resort.id, opportunityId: opportunity.id, linerId: liner.id, closerId: closer.id } as never);
    const [contract] = await db.insert(contracts).values({ number: `A10-${label}-${runId}`, customerId: customer.id, proposalId: proposal.id, status: opts.status ?? "pending_signature", totalAmount: "10000.00", signedAt: new Date() }).$returningId();
    await db.insert(contractDocuments).values({ contractId: contract.id, category: "Contrato assinado", filename: "c.pdf", storageKey: `contracts/a10-${label}-${runId}.pdf`, signed: true, signedArtifact: true });
    const installmentIds: number[] = [];
    for (const sequence of [1, 2, 3]) {
      const paid = (opts.paidSequences ?? [1]).includes(sequence);
      const [row] = await db.insert(installments).values({ contractId: contract.id, sequence, dueDate: new Date("2026-10-10T12:00:00Z"), amount: sequence === 1 ? "1000.00" : "4500.00", status: paid ? "paid" : "open", paidAmount: paid ? (sequence === 1 ? "1000.00" : "4500.00") : "0.00", paidAt: paid ? new Date("2026-10-01T12:00:00Z") : null, paymentMethod: paid ? "pix" : null }).$returningId();
      installmentIds.push(row.id);
    }
    return { contractId: contract.id, resortId: resort.id, installmentIds, linerId: liner.id, closerId: closer.id };
  }
  const validate = async (contractId: number) => { await svc.confirmPayment(adminId, { contractId, note: "conferido" }); await svc.validateSale(adminId, { contractId }); };
  const commissionsOf = (contractId: number) => db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId));
  const eventsFor = (eventName: string, aggregateId: number) => db.select().from(domainEvents).where(and(eq(domainEvents.eventName, eventName as never), eq(domainEvents.aggregateId, String(aggregateId))));
  const auditsFor = (entityType: string, entityId: number, action: string) => db.select().from(auditLogs).where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, String(entityId)), eq(auditLogs.action, action)));
  const finance = () => commissionsRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);
  const setPolicy = (resortId: number, value: string) => db.update(commercialProjectSettings).set({ commissionPolicy: value }).where(eq(commercialProjectSettings.resortId, resortId));

  it("validação com todos os papéis a 0%: nenhuma comissão, mas auditoria + evento skipped (idempotente)", async () => {
    const { contractId, resortId, installmentIds } = await seedSale("zero");
    await validate(contractId);
    expect(await commissionsOf(contractId)).toHaveLength(0);
    const events = await eventsFor("commission.automatic.skipped", installmentIds[0]);
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0].payload))).toEqual({ contractId, installmentId: installmentIds[0], resortId, reason: "zero_rate", roles: ["liner", "closer"], source: "sale_validation" });
    expect(await auditsFor("installment", installmentIds[0], "commission_skipped")).toHaveLength(1);
    await db.transaction(tx => svc.releaseCommissionsForValidatedContract(tx, { contractId, actorUserId: adminId }));
    expect(await eventsFor("commission.automatic.skipped", installmentIds[0])).toHaveLength(1);
    expect(await auditsFor("installment", installmentIds[0], "commission_skipped")).toHaveLength(1);
    expect(await eventsFor("commission.automatic.blocked", installmentIds[0])).toHaveLength(0);
  });

  it("baixa manual com 0%: registra o salto; reprocesso com taxas novas cria as comissões, uma vez só", async () => {
    const { contractId, resortId, installmentIds, linerId, closerId } = await seedSale("manual", { paidSequences: [], status: "pending_signature" });
    await validate(contractId);
    await db.update(contracts).set({ status: "active" }).where(eq(contracts.id, contractId));
    await financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never).markInstallmentPaid({ id: installmentIds[0], paymentMethod: "pix" });
    expect(await commissionsOf(contractId)).toHaveLength(0);
    const skipped = await eventsFor("commission.automatic.skipped", installmentIds[0]);
    expect(skipped).toHaveLength(1);
    expect(JSON.parse(String(skipped[0].payload))).toMatchObject({ source: "manual", reason: "zero_rate", resortId });

    // ainda a 0%: nada muda, parcela segue pendente de reprocesso
    await expect(finance().reprocessSkipped({ contractId })).resolves.toMatchObject({ candidates: 1, created: 0, stillZeroRate: 1 });
    expect(await commissionsOf(contractId)).toHaveLength(0);

    await setPolicy(resortId, rated);
    const first = await finance().reprocessSkipped({ contractId });
    expect(first).toMatchObject({ candidates: 1, created: 2, stillZeroRate: 0, createdInstallmentIds: [installmentIds[0]] });
    const rows = await commissionsOf(contractId);
    expect(rows.map(row => [row.commissionRole, row.sellerId, row.sourceInstallmentId, row.amount]).sort()).toEqual([["closer", closerId, installmentIds[0], "270.00"], ["liner", linerId, installmentIds[0], "180.00"]].sort());
    expect(await auditsFor("installment", installmentIds[0], "commission_skipped_reprocessed")).toHaveLength(1);
    for (const row of rows) {
      expect(await eventsFor("commission.created", row.id)).toHaveLength(1);
      expect(await auditsFor("sales_commission", row.id, "created")).toHaveLength(1);
    }
    expect(await auditsFor("contract", contractId, "commission_skipped_reprocess_run")).toHaveLength(2);

    // idempotência: segunda execução e execução concorrente não duplicam
    await expect(finance().reprocessSkipped({ contractId })).resolves.toMatchObject({ created: 0, alreadyCommissioned: 1 });
    await Promise.all([finance().reprocessSkipped({ contractId }), finance().reprocessSkipped({ resortId })]);
    expect((await commissionsOf(contractId)).map(row => row.id).sort()).toEqual(rows.map(row => row.id).sort());
    expect(await eventsFor("commission.automatic.skipped", installmentIds[0])).toHaveLength(1);
  });

  it("reprocesso por empreendimento só toca o empreendimento pedido; contrato fora do portão é inelegível", async () => {
    const a = await seedSale("proj-a");
    const b = await seedSale("proj-b");
    const c = await seedSale("proj-c");
    for (const sale of [a, b, c]) await validate(sale.contractId);
    await setPolicy(a.resortId, rated); await setPolicy(b.resortId, rated); await setPolicy(c.resortId, rated);
    await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, c.contractId));
    const result = await finance().reprocessSkipped({ resortId: a.resortId });
    expect(result).toMatchObject({ candidates: 1, created: 2 });
    expect(await commissionsOf(a.contractId)).toHaveLength(2);
    expect(await commissionsOf(b.contractId)).toHaveLength(0);
    await expect(finance().reprocessSkipped({ contractId: c.contractId })).resolves.toMatchObject({ created: 0, ineligible: 1 });
    expect(await commissionsOf(c.contractId)).toHaveLength(0);
    await expect(finance().reprocessSkipped({ contractId: b.contractId })).resolves.toMatchObject({ created: 2 });
  });

  it("parcela do skip que já tem comissão (qualquer papel) não é reprocessada", async () => {
    const { contractId, resortId, installmentIds, linerId } = await seedSale("manual-row");
    await validate(contractId);
    await db.insert(salesCommissions).values({ sellerId: linerId, contractId, sourceInstallmentId: installmentIds[0], commissionRole: "liner", baseAmount: "9000.00", rate: "1.00", amount: "90.00" });
    await setPolicy(resortId, rated);
    await expect(finance().reprocessSkipped({ contractId })).resolves.toMatchObject({ created: 0, alreadyCommissioned: 1 });
    expect(await commissionsOf(contractId)).toHaveLength(1);
  });

  async function seedPaidCommissionContract(label: string) {
    const sale = await seedSale(label, { policy: rated });
    await validate(sale.contractId);
    const created = await commissionsOf(sale.contractId);
    expect(created).toHaveLength(2);
    await db.update(salesCommissions).set({ status: "paid", lifecycleStatus: "paid", paidAt: new Date() }).where(eq(salesCommissions.contractId, sale.contractId));
    const [request] = await db.insert(contractCancellationRequests).values({ contractId: sale.contractId, status: "approved", reason: "Cliente desistiu", simulationSnapshot: JSON.stringify({ paidAmount: 1000, policyConfigured: false }), requestedByUserId: adminId, decidedByUserId: adminId }).$returningId();
    return { ...sale, requestId: request.id, commissionIds: created.map(row => row.id) };
  }

  it("distrato: comissão paga entra na fila (evento requested uma vez); resolver exige decisão, grava, audita e emite resolved", async () => {
    const sale = await seedPaidCommissionContract("rev");
    const admin = contractsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
    await admin.executeCancellation({ requestId: sale.requestId });
    for (const id of sale.commissionIds) {
      expect(await eventsFor("commission.reversal_review.requested", id)).toHaveLength(1);
      expect(await auditsFor("sales_commission", id, "reversal_review_pending")).toHaveLength(1);
    }
    const queue = await finance().reversalQueue();
    const mine = queue.filter(row => sale.commissionIds.includes(row.id));
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ reversalReviewStatus: "pending", sellerName: expect.any(String), contractNumber: `A10-rev-${runId}` });

    const [entry] = await db.insert(financialTransactions).values({ contractId: sale.contractId, type: "expense", category: "Estorno de comissão", description: "Compensação", amount: "200.00", status: "open", createdByUserId: adminId }).$returningId();
    const [first, second] = sale.commissionIds;
    await expect(finance().resolveReversalReview({ id: first, decision: "offset", financialTransactionId: entry.id, note: "Compensado na próxima remessa" })).resolves.toEqual({ success: true });
    await expect(finance().resolveReversalReview({ id: first, decision: "waived", note: "Segunda tentativa" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(finance().resolveReversalReview({ id: second, decision: "reversed", financialTransactionId: 99_999_999, note: "Lançamento inexistente" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(finance().resolveReversalReview({ id: second, decision: "waived", note: "Dispensada pelo gerente" })).resolves.toEqual({ success: true });

    const [rowFirst] = await db.select().from(salesCommissions).where(eq(salesCommissions.id, first));
    expect(rowFirst).toMatchObject({ status: "paid", reversalReviewStatus: "resolved", reversalReviewDecision: "offset", reversalReviewFinancialTransactionId: entry.id, reversalReviewResolvedByUserId: adminId, reversalReviewNote: "Compensado na próxima remessa" });
    const [rowSecond] = await db.select().from(salesCommissions).where(eq(salesCommissions.id, second));
    expect(rowSecond).toMatchObject({ reversalReviewDecision: "waived", reversalReviewFinancialTransactionId: null });
    const resolved = await eventsFor("commission.reversal_review.resolved", first);
    expect(resolved).toHaveLength(1);
    expect(JSON.parse(String(resolved[0].payload))).toEqual({ contractId: sale.contractId, commissionId: first, decision: "offset", financialTransactionId: entry.id });
    expect(await auditsFor("sales_commission", first, "reversal_review_resolved")).toHaveLength(1);
    expect((await finance().reversalQueue()).filter(row => sale.commissionIds.includes(row.id))).toHaveLength(0);
    expect((await finance().reversalQueue({ includeResolved: true })).filter(row => sale.commissionIds.includes(row.id))).toHaveLength(2);
  });
});
