import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, commercialFractions, contractCancellationRequests, contractDocuments, contracts, customers, domainEvents, financialPortfolioAssignments, financialTransactions, financialTransfers, installmentRenegotiations, installments, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// PKG F2-05 (CRM-PK-09), 1ª e 2ª leva: os emissores de contrato e financeiro gravam fato + auditoria + evento na MESMA transação.
// Prova no MySQL real: sucesso grava os três; falha no evento desfaz o fato (nada de contrato/lançamento sem aviso, nem aviso sem fato).
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const failure = vi.hoisted(() => ({ eventName: null as string | null }));
vi.mock("./storage", () => ({ storagePut: async (key: string) => ({ key, url: `https://storage.example/${key}` }) }));

vi.mock("./txOutbox", async importOriginal => {
  const original = await importOriginal<typeof import("./txOutbox")>();
  return {
    ...original,
    txEvent: async (tx: Parameters<typeof original.txEvent>[0], row: Parameters<typeof original.txEvent>[1]) => {
      if (failure.eventName === row.eventName) throw new Error(`falha simulada ao gravar ${row.eventName}`);
      return original.txEvent(tx, row);
    },
  };
});

describe.skipIf(!integrationUrl)("outbox transacional dos emissores de contrato e financeiro em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let contractsRouter: typeof import("./routers/contracts")["contractsRouter"];
  let financeRouter: typeof import("./routers/finance")["financeRouter"];
  let adminId: number;
  let customerId: number;
  let resortId: number;
  const previousEnv = { ...process.env };

  const admin = () => contractsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
  const financeAdmin = () => financeRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
  const eventsFor = async (eventName: string, aggregateId: number | string) => (await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, eventName as never), eq(domainEvents.aggregateId, String(aggregateId)))));
  const auditsFor = async (entityType: string, entityId: number | string, action: string) => (await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, String(entityId)), eq(auditLogs.action, action))));

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ contractsRouter } = await import("./routers/contracts"));
    ({ financeRouter } = await import("./routers/finance"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `outbox-admin-${runId}`, name: "Admin Sintético", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `SYN Outbox ${runId}`, email: `syn.outbox.${runId}@example.test`, status: "active" }).$returningId();
    [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort Outbox ${runId}` } as never).$returningId();
  });
  beforeEach(() => { failure.eventName = null; });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  async function freshFraction(label: string) {
    const [unit] = await db.insert(units).values({ resortId, code: `U-OB-${label}-${runId}` }).$returningId();
    const [fraction] = await db.insert(commercialFractions).values({ resortId, unitId: unit.id, code: `F-OB-${label}-${runId}`, sequence: 1, status: "available", listPrice: "3000.00" }).$returningId();
    return fraction.id;
  }
  const createInput = (number: string, fractionId: number) => ({ number, customerId, proposalId: null, usageModel: "flexible_week" as const, status: "pending_signature" as const, totalAmount: 3000, firstDueDate: "2026-11-10", installmentCount: 3, fractionId });

  it("contracts.create grava contrato, parcelas, auditoria e os eventos juntos, com contract.created antes de installment.scheduled", async () => {
    const fractionId = await freshFraction("ok");
    const { id } = await admin().create(createInput(`OB-OK-${runId}`, fractionId));
    expect((await eventsFor("contract.created", id))).toHaveLength(1);
    expect((await eventsFor("contract.created.v2", id))).toHaveLength(1);
    expect((await auditsFor("contract", id, "created"))).toHaveLength(1);
    expect((await eventsFor("commercial.fraction.status.changed", fractionId))).toHaveLength(1);
    expect((await auditsFor("commercial_fraction", fractionId, "sold"))).toHaveLength(1);
    const scheduled = (await db.select().from(domainEvents).where(eq(domainEvents.eventName, "installment.scheduled"))).filter(row => JSON.parse(row.payload ?? "{}").contractId === id);
    expect(scheduled).toHaveLength(3);
    const created = (await eventsFor("contract.created", id))[0];
    expect(Math.min(...scheduled.map(row => row.id))).toBeGreaterThan(created.id);
  });

  it("contracts.create: falha ao gravar o evento desfaz contrato, parcelas e a cota", async () => {
    const fractionId = await freshFraction("rb");
    const number = `OB-RB-${runId}`;
    failure.eventName = "contract.created.v2";
    await expect(admin().create(createInput(number, fractionId))).rejects.toThrow(/falha simulada/);
    expect(await db.select().from(contracts).where(eq(contracts.number, number))).toHaveLength(0);
    const [fraction] = await db.select().from(commercialFractions).where(eq(commercialFractions.id, fractionId));
    expect(fraction.status).toBe("available");
    expect(await eventsFor("commercial.fraction.status.changed", fractionId)).toHaveLength(0);
  });

  it("contracts.updateStatus grava status, auditoria e evento juntos; falha no evento mantém o status antigo", async () => {
    const fractionId = await freshFraction("st");
    const { id } = await admin().create({ ...createInput(`OB-ST-${runId}`, fractionId), status: "draft" as never });
    failure.eventName = "contract.status.updated";
    await expect(admin().updateStatus({ id, status: "pending_signature" })).rejects.toThrow(/falha simulada/);
    expect((await db.select().from(contracts).where(eq(contracts.id, id)))[0].status).toBe("draft");
    expect(await auditsFor("contract", id, "status_updated")).toHaveLength(0);
    failure.eventName = null;
    await admin().updateStatus({ id, status: "pending_signature" });
    expect((await db.select().from(contracts).where(eq(contracts.id, id)))[0].status).toBe("pending_signature");
    expect(await auditsFor("contract", id, "status_updated")).toHaveLength(1);
    expect(await eventsFor("contract.status.updated", id)).toHaveLength(1);
  });

  it("finance.createEntry e reconcileEntry: fato, auditoria e evento juntos; falha no evento não deixa lançamento órfão", async () => {
    const description = `Taxa sintética ${runId}`;
    failure.eventName = "financial.entry.created";
    await expect(financeAdmin().createEntry({ type: "expense", category: "Taxa", description, amount: 50, status: "paid" })).rejects.toThrow(/falha simulada/);
    expect(await db.select().from(financialTransactions).where(like(financialTransactions.description, description))).toHaveLength(0);

    failure.eventName = null;
    const { id } = await financeAdmin().createEntry({ type: "expense", category: "Taxa", description, amount: 50, status: "paid" });
    expect(await eventsFor("financial.entry.created", id)).toHaveLength(1);
    expect(await auditsFor("financial_transaction", id, "created")).toHaveLength(1);

    failure.eventName = "financial.entry.reconciled";
    await expect(financeAdmin().reconcileEntry({ id, reconciliationReference: `OFX-${runId}` })).rejects.toThrow(/falha simulada/);
    expect((await db.select().from(financialTransactions).where(eq(financialTransactions.id, id)))[0].reconciledAt).toBeNull();
    expect(await auditsFor("financial_transaction", id, "reconciled")).toHaveLength(0);

    failure.eventName = null;
    await expect(financeAdmin().reconcileEntry({ id, reconciliationReference: `OFX-${runId}` })).resolves.toEqual({ success: true });
    await expect(financeAdmin().reconcileEntry({ id, reconciliationReference: `OFX-${runId}` })).resolves.toEqual({ success: true, alreadyReconciled: true });
    expect(await eventsFor("financial.entry.reconciled", id)).toHaveLength(1);
    expect(await auditsFor("financial_transaction", id, "reconciled")).toHaveLength(1);
  });
  async function freshContract(label: string) {
    const fractionId = await freshFraction(label);
    const { id } = await admin().create(createInput(`OB-${label.toUpperCase()}-${runId}`, fractionId));
    return id;
  }

  it("distrato: solicitar e decidir gravam solicitação, auditoria e evento juntos; falha no evento desfaz", async () => {
    const contractId = await freshContract("ds");
    failure.eventName = "contract.cancellation.requested";
    await expect(admin().requestCancellation({ contractId, reason: "Pedido do cliente (sintético)" })).rejects.toThrow(/falha simulada/);
    expect(await db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.contractId, contractId))).toHaveLength(0);

    failure.eventName = null;
    const request = await admin().requestCancellation({ contractId, reason: "Pedido do cliente (sintético)" });
    expect(await eventsFor("contract.cancellation.requested", request.id)).toHaveLength(1);
    expect(await auditsFor("contract_cancellation_request", request.id, "requested")).toHaveLength(1);

    failure.eventName = "contract.cancellation.decided";
    await expect(admin().decideCancellation({ requestId: request.id, decision: "approved" })).rejects.toThrow(/falha simulada/);
    expect((await db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.id, request.id)))[0].status).toBe("requested");
    failure.eventName = null;
    await admin().decideCancellation({ requestId: request.id, decision: "approved" });
    expect(await eventsFor("contract.cancellation.decided", request.id)).toHaveLength(1);
    expect(await auditsFor("contract_cancellation_request", request.id, "approved")).toHaveLength(1);
  });

  it("documento do contrato: upload assinado e confirmação gravam documento, auditoria e evento juntos; falha desfaz", async () => {
    const contractId = await freshContract("dc");
    const upload = { contractId, category: "Contrato assinado", filename: `contrato-${runId}.pdf`, contentType: "application/pdf", signed: false, base64: "data:application/pdf;base64,MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" };
    failure.eventName = "contract.document.uploaded";
    await expect(admin().uploadDocument(upload)).rejects.toThrow(/falha simulada/);
    expect(await db.select().from(contractDocuments).where(eq(contractDocuments.contractId, contractId))).toHaveLength(0);

    failure.eventName = null;
    const { id } = await admin().uploadDocument(upload);
    expect(await eventsFor("contract.document.uploaded", id)).toHaveLength(1);
    expect(await auditsFor("contract_document", id, "uploaded")).toHaveLength(1);

    failure.eventName = "contract.document.signed";
    await expect(admin().markDocumentSigned({ documentId: id })).rejects.toThrow(/falha simulada/);
    expect((await db.select().from(contractDocuments).where(eq(contractDocuments.id, id)))[0].signed).toBe(false);
    failure.eventName = null;
    await expect(admin().markDocumentSigned({ documentId: id })).resolves.toEqual({ success: true, alreadySigned: false });
    await expect(admin().markDocumentSigned({ documentId: id })).resolves.toEqual({ success: true, alreadySigned: true });
    expect(await eventsFor("contract.document.signed", id)).toHaveLength(1);
  });

  it("repasse: criar e pagar gravam fato, auditoria e evento juntos; falha desfaz", async () => {
    const beneficiaryName = `Parceiro Sintético ${runId}`;
    failure.eventName = "financial.transfer.created";
    await expect(financeAdmin().createTransfer({ beneficiaryName, amount: 80, dueDate: "2026-12-20" })).rejects.toThrow(/falha simulada/);
    expect(await db.select().from(financialTransfers).where(eq(financialTransfers.beneficiaryName, beneficiaryName))).toHaveLength(0);

    failure.eventName = null;
    const { id } = await financeAdmin().createTransfer({ beneficiaryName, amount: 80, dueDate: "2026-12-20" });
    expect(await eventsFor("financial.transfer.created", id)).toHaveLength(1);
    expect(await auditsFor("financial_transfer", id, "created")).toHaveLength(1);

    failure.eventName = "financial.transfer.paid";
    await expect(financeAdmin().markTransferPaid({ id })).rejects.toThrow(/falha simulada/);
    expect((await db.select().from(financialTransfers).where(eq(financialTransfers.id, id)))[0].status).toBe("pending");
    failure.eventName = null;
    await expect(financeAdmin().markTransferPaid({ id })).resolves.toMatchObject({ success: true, alreadyPaid: false });
    await expect(financeAdmin().markTransferPaid({ id })).resolves.toMatchObject({ success: true, alreadyPaid: true });
    expect(await eventsFor("financial.transfer.paid", id)).toHaveLength(1);
    expect(await auditsFor("financial_transfer", id, "paid")).toHaveLength(1);
  });

  it("carteira financeira e acordo de parcela: fato, auditoria e evento juntos; falha desfaz", async () => {
    const contractId = await freshContract("pf");
    failure.eventName = "financial.portfolio.assigned";
    await expect(financeAdmin().assignPortfolioOwner({ contractId, ownerUserId: adminId })).rejects.toThrow(/falha simulada/);
    expect(await db.select().from(financialPortfolioAssignments).where(eq(financialPortfolioAssignments.contractId, contractId))).toHaveLength(0);
    failure.eventName = null;
    const assigned = await financeAdmin().assignPortfolioOwner({ contractId, ownerUserId: adminId });
    expect(await eventsFor("financial.portfolio.assigned", assigned.id)).toHaveLength(1);
    expect(await auditsFor("financial_portfolio_assignment", assigned.id, "assigned")).toHaveLength(1);

    const [installment] = await db.select().from(installments).where(eq(installments.contractId, contractId));
    failure.eventName = "installment.renegotiation.proposed";
    await expect(financeAdmin().createRenegotiation({ installmentId: installment.id, proposedAmount: 500, proposedDueDate: "2026-12-30" })).rejects.toThrow(/falha simulada/);
    expect(await db.select().from(installmentRenegotiations).where(eq(installmentRenegotiations.originalInstallmentId, installment.id))).toHaveLength(0);
    failure.eventName = null;
    const renegotiation = await financeAdmin().createRenegotiation({ installmentId: installment.id, proposedAmount: 500, proposedDueDate: "2026-12-30" });
    expect(await eventsFor("installment.renegotiation.proposed", renegotiation.id)).toHaveLength(1);
    expect(await auditsFor("installment_renegotiation", renegotiation.id, "created")).toHaveLength(1);
  });
});
