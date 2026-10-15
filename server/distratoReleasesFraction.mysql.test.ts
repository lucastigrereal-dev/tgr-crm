import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { commercialFractionHistory, commercialFractions, contractCancellationRequests, contracts, customers, installments, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Executar o distrato devolve a cota do contrato ao estoque ("available"), limpa os vínculos e registra o histórico.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("distrato em MySQL real devolve a cota ao estoque", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let contractsRouter: typeof import("./routers/contracts")["contractsRouter"];
  let adminId: number;
  let resortId: number;
  const previousEnv = { ...process.env };
  const admin = () => contractsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ contractsRouter } = await import("./routers/contracts"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `dfr-admin-${runId}`, name: "Gerente Sintético", role: "admin" }).$returningId();
    [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort Distrato Cota ${runId}` } as never).$returningId();
  });
  afterAll(async () => {
    process.env = previousEnv;
    await pool?.end();
  });

  async function seed(label: string, otherContract = false) {
    const [customer] = await db.insert(customers).values({ fullName: `Fulano Sintético ${label} ${runId}`, email: `fulano.${label}.${runId}@example.test`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `DFR-${label}-${runId}`, customerId: customer.id, status: "active", totalAmount: "5000.00", signedAt: new Date() }).$returningId();
    await db.insert(installments).values({ contractId: contract.id, sequence: 1, dueDate: new Date("2026-12-10T12:00:00Z"), amount: "500.00", status: "open", paidAmount: "0.00" });
    const [unit] = await db.insert(units).values({ resortId, code: `U-DFR-${label}-${runId}` }).$returningId();
    const [fraction] = await db.insert(commercialFractions).values({ resortId, unitId: unit.id, code: `F-DFR-${label}-${runId}`, sequence: 1, status: "sold", currentContractId: contract.id, heldUntil: new Date("2030-01-01T12:00:00Z"), listPrice: "5000.00" }).$returningId();
    const [request] = await db.insert(contractCancellationRequests).values({ contractId: contract.id, status: "approved", reason: "Cliente desistiu (sintético)", simulationSnapshot: JSON.stringify({ paidAmount: 0, policyConfigured: false }), requestedByUserId: adminId, decidedByUserId: adminId }).$returningId();
    return { contractId: contract.id, fractionId: fraction.id, requestId: request.id };
  }
  const fractionOf = async (id: number) => (await db.select().from(commercialFractions).where(eq(commercialFractions.id, id)))[0];

  it("cota vendida volta a available, sem contrato/proposta/reserva, com histórico sold -> available", async () => {
    const s = await seed("sold");
    expect(await fractionOf(s.fractionId)).toMatchObject({ status: "sold", currentContractId: s.contractId });
    await expect(admin().executeCancellation({ requestId: s.requestId })).resolves.toMatchObject({ success: true, returnedFractionIds: [s.fractionId] });
    expect(await fractionOf(s.fractionId)).toMatchObject({ status: "available", currentContractId: null, currentProposalId: null, heldUntil: null, blockedReason: null });
    const history = await db.select().from(commercialFractionHistory).where(eq(commercialFractionHistory.fractionId, s.fractionId));
    expect(history.map(row => [row.fromStatus, row.toStatus, row.contractId])).toEqual([["sold", "available", s.contractId]]);
  });

  it("não mexe na cota de outro contrato nem repete o retorno ao reexecutar", async () => {
    const mine = await seed("mine");
    const other = await seed("other");
    await admin().executeCancellation({ requestId: mine.requestId });
    expect(await fractionOf(mine.fractionId)).toMatchObject({ status: "available" });
    expect(await fractionOf(other.fractionId)).toMatchObject({ status: "sold", currentContractId: other.contractId });
    await expect(admin().executeCancellation({ requestId: mine.requestId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.select().from(commercialFractionHistory).where(eq(commercialFractionHistory.fractionId, mine.fractionId)))).toHaveLength(1);
  });

});
