import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { billingRecords, domainEvents, commercialFractions, commercialPolicyVersions, contractMonetaryAdjustments, contracts, customers, installments, monetaryIndexValues, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// applyAdjustment em MySQL real: aplica uma vez, recusa repetição, recusa série incompleta e cobrança ativa, e exige a confirmação literal.
// Dados 100% sintéticos; cada valor único leva o runId.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const THROUGH = "2026-04-15";

describe.skipIf(!integrationUrl)("monetaryAdjustments.applyAdjustment em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let router: typeof import("./routers/monetaryAdjustments")["monetaryAdjustmentsRouter"];
  let financeId: number;
  let sellerId: number;
  let resortId: number;
  let policyId: number;
  const indexCode = `IDX${runId}`.toUpperCase();
  const previousEnv = { ...process.env };

  const finance = () => router.createCaller({ user: { id: financeId, role: "finance" } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ monetaryAdjustmentsRouter: router } = await import("./routers/monetaryAdjustments"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: financeId }] = await db.insert(users).values({ openId: `adj-fin-${runId}`, name: "Financeiro Sintético", role: "finance" }).$returningId();
    [{ id: sellerId }] = await db.insert(users).values({ openId: `adj-seller-${runId}`, name: "Vendedor Sintético", role: "seller" }).$returningId();
    [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort Reajuste ${runId}` } as never).$returningId();
    [{ id: policyId }] = await db.insert(commercialPolicyVersions).values({
      resortId, policyType: "monetary_adjustment", version: `adj-${runId}`,
      policyJson: JSON.stringify({ indexCode, periodicityMonths: 3, spreadMonthlyPercent: 0 }),
      approvedByUserId: financeId,
    }).$returningId();
    // Série completa de fev a abr/2026 (1% ao mês). Maio/2026 fica de fora de propósito.
    await db.insert(monetaryIndexValues).values(["2026-02-01", "2026-03-01", "2026-04-01"].map(referenceDate => ({
      indexCode, referenceDate: new Date(`${referenceDate}T12:00:00Z`), variationPercent: "1.000000", source: "Fixture sintética", importedByUserId: financeId,
    })));
  });

  afterAll(async () => {
    process.env = previousEnv;
    await pool?.end();
  });

  /** Contrato assinado em 15/01/2026 com duas parcelas abertas de 1000,00 e uma paga; cota vendida liga o contrato ao empreendimento. */
  async function seedContract(label: string) {
    const [customer] = await db.insert(customers).values({ fullName: `Fulano Sintético ${label} ${runId}`, email: `fulano.${label}.${runId}@example.test`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `ADJ-${label}-${runId}`, customerId: customer.id, status: "active", totalAmount: "3000.00", signedAt: new Date("2026-01-15T12:00:00Z") }).$returningId();
    const [paid] = await db.insert(installments).values({ contractId: contract.id, sequence: 1, dueDate: new Date("2026-02-10T12:00:00Z"), amount: "1000.00", status: "paid", paidAmount: "1000.00", paidAt: new Date() }).$returningId();
    const [open1] = await db.insert(installments).values({ contractId: contract.id, sequence: 2, dueDate: new Date("2026-06-10T12:00:00Z"), amount: "1000.00", status: "open" }).$returningId();
    const [open2] = await db.insert(installments).values({ contractId: contract.id, sequence: 3, dueDate: new Date("2026-07-10T12:00:00Z"), amount: "1000.00", status: "overdue" }).$returningId();
    const [unit] = await db.insert(units).values({ resortId, code: `U-ADJ-${label}-${runId}` }).$returningId();
    await db.insert(commercialFractions).values({ resortId, unitId: unit.id, code: `F-ADJ-${label}-${runId}`, sequence: 1, status: "sold", currentContractId: contract.id, listPrice: "3000.00" });
    return { contractId: contract.id, paidId: paid.id, open1Id: open1.id, open2Id: open2.id };
  }
  const amounts = async (contractId: number) => Object.fromEntries((await db.select().from(installments).where(eq(installments.contractId, contractId))).map(row => [row.id, row.amount]));
  const adjustments = (contractId: number) => db.select().from(contractMonetaryAdjustments).where(eq(contractMonetaryAdjustments.contractId, contractId));
  const input = (contractId: number, throughDate = THROUGH) => ({ contractId, policyVersionId: policyId, throughDate, confirmation: "APPLY_REVIEWED_ADJUSTMENT" as const });

  it("aplica o reajuste: atualiza só as parcelas abertas/vencidas e grava a memória de cálculo", async () => {
    const seed = await seedContract("ok");
    const result = await finance().applyAdjustment(input(seed.contractId));
    // 3 meses a 1%: 1,01^3 = 1,030301 -> 1000,00 vira 1030,30.
    expect(result.calculation).toMatchObject({ eligible: true, totalFactor: 1.030301, beforeTotal: 2000, afterTotal: 2060.6 });
    expect(await amounts(seed.contractId)).toEqual({ [seed.paidId]: "1000.00", [seed.open1Id]: "1030.30", [seed.open2Id]: "1030.30" });
    const rows = await adjustments(seed.contractId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ policyVersionId: policyId, indexCode, periodicityMonths: 3, appliedByUserId: financeId, beforeTotal: "2000.00", afterTotal: "2060.60", totalFactor: "1.0303010000" });
    expect(String(rows[0].baseDate)).toContain("2026");
    expect(result.adjustmentId).toBe(rows[0].id);
    // PKG-FIN-03: o Financial recebe o novo valor das duas parcelas reajustadas (e nada da parcela paga).
    const scheduled = (await db.select().from(domainEvents).where(eq(domainEvents.eventName, "installment.scheduled")))
      .map(row => JSON.parse(row.payload ?? "{}")).filter(payload => payload.contractId === seed.contractId);
    expect(scheduled.map(payload => [payload.installmentId, payload.amount]).sort()).toEqual([[seed.open1Id, "1030.30"], [seed.open2Id, "1030.30"]].sort());
    expect(scheduled[0]).toMatchObject({ customerId: expect.any(Number), sequence: expect.any(Number), dueDate: expect.stringMatching(/^2026-0[67]-10$/) });
  });

  it("repetir o mesmo reajuste (mesma data) é recusado e não mexe nas parcelas; o índice único também barra a linha duplicada", async () => {
    const seed = await seedContract("dup");
    await finance().applyAdjustment(input(seed.contractId));
    const afterFirst = await amounts(seed.contractId);
    // A base passa a ser a data do último reajuste: repetir a mesma data cai na trava "data final posterior à base".
    await expect(finance().applyAdjustment(input(seed.contractId))).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("posterior") });
    expect(await amounts(seed.contractId)).toEqual(afterFirst);
    expect(await adjustments(seed.contractId)).toHaveLength(1);
    // Rede de proteção no banco: a mesma (contrato, throughDate) não entra duas vezes.
    const [existing] = await adjustments(seed.contractId);
    const { id: _id, createdAt: _createdAt, ...copy } = existing;
    await expect(db.insert(contractMonetaryAdjustments).values(copy)).rejects.toThrow();
    expect(await adjustments(seed.contractId)).toHaveLength(1);
  });

  it("recusa com PRECONDITION_FAILED quando a série do índice está incompleta (mês de maio ausente) e nada muda", async () => {
    const seed = await seedContract("gap");
    const before = await amounts(seed.contractId);
    await expect(finance().applyAdjustment(input(seed.contractId, "2026-05-15"))).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("incompleta") });
    expect(await amounts(seed.contractId)).toEqual(before);
    expect(await adjustments(seed.contractId)).toHaveLength(0);
  });

  it("recusa com PRECONDITION_FAILED quando há cobrança ativa para parcela que seria reajustada, e nada muda", async () => {
    const seed = await seedContract("bill");
    await db.insert(billingRecords).values({ installmentId: seed.open1Id, status: "generated", gatewayProvider: "manual", amount: "1000.00", dueDate: new Date("2026-06-10T12:00:00Z"), idempotencyKey: `adj-bill-${runId}` });
    const before = await amounts(seed.contractId);
    await expect(finance().applyAdjustment(input(seed.contractId))).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("cobranças ativas") });
    expect(await amounts(seed.contractId)).toEqual(before);
    expect(await adjustments(seed.contractId)).toHaveLength(0);
  });

  it("a palavra de confirmação é imposta pelo zod (BAD_REQUEST) e o papel vendedor é barrado", async () => {
    const seed = await seedContract("conf");
    const before = await amounts(seed.contractId);
    await expect(finance().applyAdjustment({ ...input(seed.contractId), confirmation: "OK" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(router.createCaller({ user: { id: sellerId, role: "seller" } } as never).applyAdjustment(input(seed.contractId))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await amounts(seed.contractId)).toEqual(before);
    expect(await adjustments(seed.contractId)).toHaveLength(0);
  });
});
