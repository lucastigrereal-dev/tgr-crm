import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, commercialFractions, contracts, customers, resorts, saleValidations, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-D1 em MySQL real: indicadores oficiais. Dados sintéticos (SYN-), resort próprio por teste para isolar o filtro.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const day = (d: number) => new Date(Date.UTC(2026, 9, d, 15, 0, 0));

describe.skipIf(!integrationUrl)("D1: indicadores oficiais", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let adminId = 0;
  let customerId = 0;
  const previousEnv = { ...process.env };
  const caller = async (role: "admin" | "finance" | "seller" = "admin") => (await import("./routers/officialIndicators")).officialIndicatorsRouter.createCaller({ user: { id: adminId, role } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `oi-admin-${runId}`, name: "Admin SYN", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `SYN Indicadores ${runId}`, email: `syn.oi.${runId}@example.test`, status: "active" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const customerOf = new Map<number, number>();
  async function newResort(label: string) {
    const id = (await db.insert(resorts).values({ name: `SYN Resort OI-${label} ${runId}` } as never).$returningId())[0]!.id;
    customerOf.set(id, (await db.insert(customers).values({ fullName: `SYN OI ${label} ${runId}`, email: `syn.oi.${label}.${runId}@example.test`, status: "active" }).$returningId())[0]!.id);
    return id;
  }
  const attend = (resortId: number, over: Record<string, unknown> = {}) => db.insert(captureRecords).values({ customerId: customerOf.get(resortId)!, resortId, checkedInAt: day(10), presentationStatus: "closed", ...over } as never);
  async function validatedSale(resortId: number, label: string, quotas: number, validatedAt: Date, status = "active") {
    const [c] = await db.insert(contracts).values({ number: `OI-${label}-${runId}`, customerId: customerOf.get(resortId)!, resortId, usageModel: "fixed_week", status, totalAmount: "1000.00" } as never).$returningId();
    await db.insert(saleValidations).values({ contractId: c.id, validatedAt } as never);
    for (let i = 0; i < quotas; i += 1) {
      const [u] = await db.insert(units).values({ resortId, code: `U-OI-${label}-${i}-${runId}` }).$returningId();
      await db.insert(commercialFractions).values({ resortId, unitId: u.id, code: `F-OI-${label}-${i}-${runId}`, sequence: 1, status: "sold", currentContractId: c.id, listPrice: "1000.00" } as never);
    }
    return c.id;
  }
  const query = async (resortId: number) => (await caller()).get({ from: "2026-10-01", to: "2026-10-31", resortId });

  it("caso 10 atendimentos concluídos, 2 vendas validadas, 3 cotas => 20% e 30 por 100; won manual, cancelado e fora do período não contam", async () => {
    const resortId = await newResort("A");
    for (let i = 0; i < 10; i += 1) await attend(resortId);
    const [other] = await db.insert(customers).values({ fullName: `SYN Outro ${runId}`, email: `syn.oi.other.${runId}@example.test`, status: "active" }).$returningId();
    await attend(resortId, { customerId: other.id, presentationStatus: "presented" }); // em andamento, sem venda: fora
    await attend(resortId, { checkedInAt: new Date(Date.UTC(2026, 10, 2)) }); // fora do período
    await validatedSale(resortId, "A1", 2, day(12));
    await validatedSale(resortId, "A2", 1, day(15));
    await validatedSale(resortId, "A3", 1, day(16), "cancelled");
    await validatedSale(resortId, "A4", 1, new Date(Date.UTC(2026, 10, 3)));
    const result = await query(resortId);
    expect(result).toMatchObject({ attendances: 10, validatedSales: 2, soldQuotas: 3, utilizationPct: 20, efficiencyPer100: 30, provisional: true });
    expect(result.denominator).toMatchObject({ includeInProgress: false, inProgressExcluded: 1 });
    expect(result.numerator.manualWonIgnored).toBe(true);
  });

  it("venda validada sem fração vinculada conta como 1 cota", async () => {
    const resortId = await newResort("B");
    await attend(resortId);
    await validatedSale(resortId, "B1", 0, day(12));
    expect(await query(resortId)).toMatchObject({ attendances: 1, validatedSales: 1, soldQuotas: 1, utilizationPct: 100 });
  });

  it("configuração: só admin liga 'em andamento no denominador'; muda o resultado e deixa trilha", async () => {
    const resortId = await newResort("C");
    await attend(resortId); await attend(resortId, { presentationStatus: "presented" });
    expect((await query(resortId)).attendances).toBe(1);
    await expect((await caller("finance")).setConfig({ includeInProgress: true })).rejects.toThrow();
    await (await caller()).setConfig({ includeInProgress: true });
    try {
      expect((await query(resortId)).attendances).toBe(2);
      expect((await (await caller("finance")).config()).includeInProgress).toBe(true);
    } finally { await (await caller()).setConfig({ includeInProgress: false }); }
    const trail = await db.select().from(auditLogs).where(eq(auditLogs.entityType, "official_indicators"));
    expect(trail.length).toBeGreaterThanOrEqual(2);
  });

  it("vendedor não lê os indicadores oficiais e período inválido é recusado", async () => {
    await expect((await caller("seller")).get({ from: "2026-10-01", to: "2026-10-31" })).rejects.toThrow();
    await expect((await caller()).get({ from: "2026-10-31", to: "2026-10-01" })).rejects.toThrow(/Período/);
  });

  it("Codex 1: casal em andamento na sala mas com venda validada do CRM entra no denominador", async () => {
    const resortId = await newResort("D");
    const [buyer] = await db.insert(customers).values({ fullName: `SYN Comprador ${runId}`, email: `syn.buy.${runId}@example.test`, status: "active" }).$returningId();
    await db.insert(captureRecords).values({ customerId: buyer.id, resortId, checkedInAt: day(10), presentationStatus: "presented" } as never);
    const [c] = await db.insert(contracts).values({ number: `OI-D1-${runId}`, customerId: buyer.id, resortId, usageModel: "fixed_week", status: "active", totalAmount: "1000.00" } as never).$returningId();
    await db.insert(saleValidations).values({ contractId: c.id, validatedAt: day(12) } as never);
    expect(await query(resortId)).toMatchObject({ attendances: 1, validatedSales: 1, utilizationPct: 100 });
  });

  it("Codex 2: data inexistente (2026-02-31) é recusada", async () => {
    await expect((await caller()).get({ from: "2026-02-01", to: "2026-02-31" })).rejects.toThrow(/inexistente/i);
  });

  it("Codex 3: o dia vale no fuso do projeto (America/Recife), não em UTC", async () => {
    const resortId = await newResort("E");
    // 02:00Z de 1/11 ainda é 31/10 em Recife (UTC-3): entra em outubro. 02:00Z de 1/10 é 30/09 em Recife: fica fora.
    await attend(resortId, { checkedInAt: new Date(Date.UTC(2026, 10, 1, 2, 0, 0)) });
    await attend(resortId, { checkedInAt: new Date(Date.UTC(2026, 9, 1, 2, 0, 0)) });
    expect(await query(resortId)).toMatchObject({ attendances: 1 });
  });
});
