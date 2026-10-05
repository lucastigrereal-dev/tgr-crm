import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import {
  auditLogs,
  captureRecords,
  commercialFractionHistory,
  commercialFractions,
  commercialPolicyVersions,
  contracts,
  customers,
  domainEvents,
  financialTransactions,
  installments,
  opportunities,
  proposals,
  resorts,
  salesCommissions,
  units,
} from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { isDuplicateKeyError } from "./mysqlErrors";
import { materializeSalesCommandSale, type SalesCommandSale } from "./salesCommandBridge";

// Integração real contra MySQL descartável. Só roda quando TGR_MYSQL_INTEGRATION_URL
// aponta para um banco migrado cujo nome termina em _e2e, _test ou _staging.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

function cents(value: string | number | null | undefined) {
  return Math.round(Number(value ?? 0) * 100);
}

describe.skipIf(!integrationUrl)("Sales Command → CRM em MySQL real: fração exata e atribuição", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedProject(label: string, fractionCount: number, balanceInstallmentCount = 7) {
    const name = `KAN31 ${label} ${runId}`;
    const externalKey = `kan31-${label}-${runId}`;
    const [resort] = await db.insert(resorts).values({ name, externalKey }).$returningId();
    const [unit] = await db.insert(units).values({ resortId: resort.id, code: `U-${label}` }).$returningId();
    await db.insert(commercialPolicyVersions).values({
      resortId: resort.id,
      policyType: "sale_terms",
      version: "kan31-v1",
      policyJson: JSON.stringify({ usageModel: "fixed_week", balanceInstallmentCount, balanceCadenceMonths: 1 }),
      effectiveAt: new Date("2026-01-01T00:00:00Z"),
    });
    for (let sequence = 1; sequence <= fractionCount; sequence++) {
      await db.insert(commercialFractions).values({
        resortId: resort.id,
        unitId: unit.id,
        code: `F-${label}-${sequence}`,
        sequence,
        listPrice: "10000.00",
      });
    }
    return { resortId: resort.id, project: { externalKey, name, timezone: "America/Sao_Paulo" } };
  }

  function saleEvent(project: SalesCommandSale["project"], overrides: Partial<SalesCommandSale["sale"]> = {}, saleId = `sale-${randomUUID()}`): SalesCommandSale {
    return {
      eventId: `evt-${randomUUID()}`,
      eventName: "sale.ready_for_contract.v1",
      source: "sales-command",
      correlationId: `corr-${randomUUID()}`,
      occurredAt: "2026-10-04T15:30:00.000Z",
      project,
      saleId,
      encounterId: `enc-${randomUUID()}`,
      customer: { name: `Casal KAN31 ${runId}`, phone: `+55119${Math.floor(Math.random() * 1e8)}` },
      sale: {
        quotasCount: 2,
        vgvCents: 1_000_001,
        entryContractedCents: 100_000,
        entryReceivedCents: 50_000,
        entryInstallmentCount: 3,
        entrySchedule: [
          { sequence: 1, amountCents: 33_334, dueDate: "2026-10-04" },
          { sequence: 2, amountCents: 33_333, dueDate: "2026-11-04" },
          { sequence: 3, amountCents: 33_333, dueDate: "2026-12-04" },
        ],
        firstBalanceDueInDays: 30,
        paymentMethods: ["pix"],
        ...overrides,
      },
    };
  }

  it("consome exatamente quotasCount frações e reconcilia valores ao centavo", async () => {
    const { resortId, project } = await seedProject("exact", 5);
    const event = saleEvent(project);

    const result = await db.transaction(tx => materializeSalesCommandSale(tx, event));

    expect(result.replay).toBe(false);
    expect(result.fractionIds).toHaveLength(2);

    const sold = await db.select().from(commercialFractions)
      .where(and(eq(commercialFractions.resortId, resortId), eq(commercialFractions.status, "sold")))
      .orderBy(asc(commercialFractions.id));
    expect(sold.map(row => row.id)).toEqual(result.fractionIds);
    expect(sold.every(row => row.currentContractId === result.contractId && row.currentProposalId === result.proposalId)).toBe(true);
    const available = await db.select().from(commercialFractions)
      .where(and(eq(commercialFractions.resortId, resortId), eq(commercialFractions.status, "available")));
    expect(available).toHaveLength(3);

    const history = await db.select().from(commercialFractionHistory).where(eq(commercialFractionHistory.contractId, result.contractId));
    expect(history.map(row => row.fractionId).sort((a, b) => a - b)).toEqual(result.fractionIds);
    expect(history.every(row => row.fromStatus === "available" && row.toStatus === "sold" && row.actorUserId === null)).toBe(true);

    const schedule = await db.select().from(installments).where(eq(installments.contractId, result.contractId)).orderBy(asc(installments.sequence));
    expect(schedule).toHaveLength(3 + 7);
    expect(schedule.map(row => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(schedule.reduce((sum, row) => sum + cents(row.amount), 0)).toBe(1_000_001);
    expect(schedule.slice(0, 3).reduce((sum, row) => sum + cents(row.amount), 0)).toBe(100_000);
    expect(schedule.reduce((sum, row) => sum + cents(row.paidAmount), 0)).toBe(50_000);
    expect(schedule[0]).toMatchObject({ status: "paid", paymentMethod: "pix" });
    expect(cents(schedule[1].paidAmount)).toBe(16_666);
    expect(schedule[1]).toMatchObject({ status: "open", paymentMethod: "pix" });
    expect(schedule[2]).toMatchObject({ status: "open", paymentMethod: null });
    const balanceAmounts = schedule.slice(3).map(row => cents(row.amount));
    expect(Math.max(...balanceAmounts) - Math.min(...balanceAmounts)).toBeLessThanOrEqual(1);

    const [contract] = await db.select().from(contracts).where(eq(contracts.id, result.contractId));
    expect(cents(contract.totalAmount)).toBe(1_000_001);
    const [proposal] = await db.select().from(proposals).where(eq(proposals.id, result.proposalId));
    expect(cents(proposal.totalAmount)).toBe(1_000_001);
    expect(cents(proposal.downPaymentAmount)).toBe(100_000);
    expect(proposal.installmentCount).toBe(10);

    const entryCash = await db.select().from(financialTransactions).where(eq(financialTransactions.contractId, result.contractId));
    expect(entryCash).toHaveLength(1);
    expect(cents(entryCash[0].amount)).toBe(50_000);
  });

  it("atribui a venda à origem Sales Command sem inventar vendedor nem comissão", async () => {
    const { resortId, project } = await seedProject("attr", 2);
    const event = saleEvent(project);

    const result = await db.transaction(tx => materializeSalesCommandSale(tx, event));

    const [contract] = await db.select().from(contracts).where(eq(contracts.id, result.contractId));
    expect(contract).toMatchObject({ externalSource: "sales-command", externalSaleId: event.saleId, sellerId: null, customerId: result.customerId, proposalId: result.proposalId });
    expect(contract.notes).toContain(event.encounterId);
    expect(contract.notes).toContain(event.correlationId);

    const [opportunity] = await db.select().from(opportunities).where(eq(opportunities.id, result.opportunityId));
    expect(opportunity).toMatchObject({ source: "Sales Command", stage: "won", customerId: result.customerId });
    const [customer] = await db.select().from(customers).where(eq(customers.id, result.customerId));
    expect(customer.acquisitionSource).toBe("Sales Command");

    const captures = await db.select().from(captureRecords).where(eq(captureRecords.opportunityId, result.opportunityId));
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ resortId, customerId: result.customerId, captureLocation: "Sales Command" });

    const commissions = await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, result.contractId));
    expect(commissions).toHaveLength(0);

    const [event0] = await db.select().from(domainEvents).where(eq(domainEvents.idempotencyKey, `sales-command:sale:${event.saleId}`));
    const lineage = JSON.parse(String(event0.payload));
    expect(lineage).toMatchObject({
      saleId: event.saleId,
      encounterId: event.encounterId,
      correlationId: event.correlationId,
      contractId: result.contractId,
      resortId,
      quotasCount: 2,
      fractionIds: result.fractionIds,
      vgvCents: 1_000_001,
      entryContractedCents: 100_000,
      entryReceivedCents: 50_000,
    });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `audit:sales-command:sale:${event.saleId}`));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "contract", entityId: String(result.contractId), action: "sales_command_formalized", actorUserId: null });
  });

  it("replay do mesmo saleId não duplica contrato, parcela nem fração", async () => {
    const { resortId, project } = await seedProject("replay", 4);
    const event = saleEvent(project);

    const first = await db.transaction(tx => materializeSalesCommandSale(tx, event));
    const second = await db.transaction(tx => materializeSalesCommandSale(tx, { ...event, eventId: `evt-${randomUUID()}` }));

    expect(second).toMatchObject({ replay: true, contractId: first.contractId, proposalId: first.proposalId, opportunityId: first.opportunityId, customerId: first.customerId, fractionIds: first.fractionIds, installmentCount: first.installmentCount });
    expect(await db.select().from(contracts).where(eq(contracts.externalSaleId, event.saleId))).toHaveLength(1);
    expect(await db.select().from(installments).where(eq(installments.contractId, first.contractId))).toHaveLength(first.installmentCount);
    expect(await db.select().from(commercialFractions).where(and(eq(commercialFractions.resortId, resortId), eq(commercialFractions.status, "sold")))).toHaveLength(2);
    expect(await db.select().from(commercialFractionHistory).where(eq(commercialFractionHistory.contractId, first.contractId))).toHaveLength(2);
    // ADR-004: o contrato vindo do Sales também anuncia o valor total ao Financial, uma única vez mesmo com replay.
    const v2 = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "contract.created.v2"), eq(domainEvents.aggregateId, String(first.contractId))));
    expect(v2).toHaveLength(1);
    expect(JSON.parse(String(v2[0].payload))).toEqual({ contractId: first.contractId, saleId: event.saleId, customerId: first.customerId, totalAmount: "10000.01", currency: "BRL", status: "pending_signature", usageModel: "fixed_week", source: "sales-command" });
  });

  it("estoque insuficiente aborta sem deixar contrato, cliente nem fração parcial", async () => {
    const { resortId, project } = await seedProject("short", 1);
    const event = saleEvent(project);

    await expect(db.transaction(tx => materializeSalesCommandSale(tx, event))).rejects.toThrow("Insufficient commercial fraction inventory");

    expect(await db.select().from(contracts).where(eq(contracts.externalSaleId, event.saleId))).toHaveLength(0);
    expect(await db.select().from(customers).where(eq(customers.phone, event.customer.phone!))).toHaveLength(0);
    expect(await db.select().from(captureRecords).where(eq(captureRecords.resortId, resortId))).toHaveLength(0);
    const fractions = await db.select().from(commercialFractions).where(eq(commercialFractions.resortId, resortId));
    expect(fractions.map(row => row.status)).toEqual(["available"]);
  });

  it("duas vendas concorrentes nunca vendem a mesma fração", async () => {
    const { resortId, project } = await seedProject("race", 3);
    const left = saleEvent(project);
    const right = saleEvent(project);

    const outcomes = await Promise.allSettled([
      db.transaction(tx => materializeSalesCommandSale(tx, left)),
      db.transaction(tx => materializeSalesCommandSale(tx, right)),
    ]);

    const fulfilled = outcomes.filter(item => item.status === "fulfilled");
    const rejected = outcomes.filter(item => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/Insufficient commercial fraction inventory|claimed concurrently/);

    const sold = await db.select().from(commercialFractions).where(and(eq(commercialFractions.resortId, resortId), eq(commercialFractions.status, "sold")));
    expect(sold).toHaveLength(2);
    expect(new Set(sold.map(row => row.currentContractId)).size).toBe(1);
    const history = await db.select().from(commercialFractionHistory).where(eq(commercialFractionHistory.toStatus, "sold"));
    const raceHistory = history.filter(row => sold.some(fraction => fraction.id === row.fractionId));
    expect(raceHistory).toHaveLength(2);
  });

  it("corrida do mesmo saleId falha com chave duplicada reconhecível para replay", async () => {
    const { resortId, project } = await seedProject("same-sale", 4);
    const event = saleEvent(project);

    const outcomes = await Promise.allSettled([
      db.transaction(tx => materializeSalesCommandSale(tx, event)),
      db.transaction(tx => materializeSalesCommandSale(tx, { ...event, eventId: `evt-${randomUUID()}` })),
    ]);

    const rejected = outcomes.filter(item => item.status === "rejected") as PromiseRejectedResult[];
    expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isDuplicateKeyError(rejected[0].reason)).toBe(true);
    expect(await db.select().from(contracts).where(eq(contracts.externalSaleId, event.saleId))).toHaveLength(1);
    expect(await db.select().from(commercialFractions).where(and(eq(commercialFractions.resortId, resortId), eq(commercialFractions.status, "sold")))).toHaveLength(2);
  });
});
