import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { commercialFractionHolds, commercialFractions, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Prova em MySQL real do provisionamento canônico 60 UHs x 52 cotas = 3.120 e da
// proteção contra venda dupla. Tudo sintético: nomes e códigos não são os do
// empreendimento real e nenhum dado pessoal é usado.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const UNITS = 60;
const FRACTIONS_PER_UNIT = 52;
const TOTAL = UNITS * FRACTIONS_PER_UNIT;

describe.skipIf(!integrationUrl)("estoque 60 UHs x 52 cotas em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let inventoryRouter: typeof import("./routers/inventory").inventoryRouter;
  let adminId: number;
  let sellerA: number;
  let sellerB: number;
  let resortId: number;
  const previousEnv = { ...process.env };

  const asUser = (id: number, role: "admin" | "seller") =>
    inventoryRouter.createCaller({ user: { id, role } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ inventoryRouter } = await import("./routers/inventory"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 8 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `inv-admin-${runId}`, name: "Admin Estoque", role: "admin" }).$returningId();
    [{ id: sellerA }] = await db.insert(users).values({ openId: `inv-seller-a-${runId}`, name: "Vendedor A", role: "seller" }).$returningId();
    [{ id: sellerB }] = await db.insert(users).values({ openId: `inv-seller-b-${runId}`, name: "Vendedor B", role: "seller" }).$returningId();
    [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort Sintetico ${runId}`, status: "active" }).$returningId();
    await db.insert(units).values(
      Array.from({ length: UNITS }, (_, index) => ({ resortId, code: `UH${String(index + 1).padStart(3, "0")}` })),
    );
  });

  afterAll(async () => {
    process.env = previousEnv;
    await pool?.end();
  });

  async function fractionCount() {
    const [row] = await db.select({ total: count() }).from(commercialFractions).where(eq(commercialFractions.resortId, resortId));
    return Number(row.total);
  }

  it("bootstrap gera exatamente 3.120 cotas, 52 por UH, sem código repetido", async () => {
    const result = await asUser(adminId, "admin").bootstrap({ resortId, fractionsPerUnit: FRACTIONS_PER_UNIT });

    expect(result).toEqual({ created: TOTAL, units: UNITS, expectedTotal: TOTAL });
    expect(await fractionCount()).toBe(TOTAL);
    const [{ codes }] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(DISTINCT code) AS codes FROM commercial_fractions WHERE resortId = ?", [resortId],
    ).then(([rows]) => rows);
    expect(Number(codes)).toBe(TOTAL);
    const [perUnit] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT MIN(n) AS minimo, MAX(n) AS maximo, COUNT(*) AS unidades FROM (SELECT unitId, COUNT(*) AS n FROM commercial_fractions WHERE resortId = ? GROUP BY unitId) t", [resortId],
    );
    expect(perUnit[0]).toMatchObject({ minimo: FRACTIONS_PER_UNIT, maximo: FRACTIONS_PER_UNIT, unidades: UNITS });
    const [notAvailable] = await db.select({ total: count() }).from(commercialFractions)
      .where(and(eq(commercialFractions.resortId, resortId), eq(commercialFractions.status, "held")));
    expect(Number(notAvailable.total)).toBe(0);
  });

  it("rodar o bootstrap de novo não cria nada (idempotente)", async () => {
    const again = await asUser(adminId, "admin").bootstrap({ resortId, fractionsPerUnit: FRACTIONS_PER_UNIT });

    expect(again.created).toBe(0);
    expect(await fractionCount()).toBe(TOTAL);
  });

  it("dois vendedores reservando a mesma cota ao mesmo tempo: só um ganha, sem venda dupla", async () => {
    const [fraction] = await db.select().from(commercialFractions).where(eq(commercialFractions.resortId, resortId)).limit(1);

    const outcomes = await Promise.allSettled([
      asUser(sellerA, "seller").createHold({ fractionId: fraction.id, ttlMinutes: 30 }),
      asUser(sellerB, "seller").createHold({ fractionId: fraction.id, ttlMinutes: 30 }),
    ]);

    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.find(outcome => outcome.status === "rejected") as PromiseRejectedResult;
    expect(String(loser.reason?.message)).toMatch(/já está reservada/);
    const active = await db.select().from(commercialFractionHolds)
      .where(and(eq(commercialFractionHolds.fractionId, fraction.id), eq(commercialFractionHolds.status, "active")));
    expect(active).toHaveLength(1);
    const [row] = await db.select().from(commercialFractions).where(eq(commercialFractions.id, fraction.id));
    expect(row.status).toBe("held");
  });

  it("cota vendida e cota bloqueada recusam nova reserva", async () => {
    const rows = await db.select().from(commercialFractions).where(eq(commercialFractions.resortId, resortId)).limit(3);
    const [, sold, blocked] = rows;
    await db.update(commercialFractions).set({ status: "sold" }).where(eq(commercialFractions.id, sold.id));
    await db.update(commercialFractions).set({ status: "blocked", blockedReason: "teste sintetico" }).where(eq(commercialFractions.id, blocked.id));

    await expect(asUser(sellerA, "seller").createHold({ fractionId: sold.id })).rejects.toThrow(/já foi vendida/);
    await expect(asUser(sellerA, "seller").createHold({ fractionId: blocked.id })).rejects.toThrow(/bloqueada/);
    const holds = await db.select({ total: count() }).from(commercialFractionHolds)
      .where(eq(commercialFractionHolds.fractionId, sold.id));
    expect(Number(holds[0].total)).toBe(0);
  });

  it("dois bootstraps simultâneos nunca duplicam cota (índice único segura)", async () => {
    const [{ id: otherResort }] = await db.insert(resorts).values({ name: `Resort Concorrente ${runId}`, status: "active" }).$returningId();
    await db.insert(units).values(Array.from({ length: 5 }, (_, index) => ({ resortId: otherResort, code: `CU${index + 1}` })));

    const outcomes = await Promise.allSettled([
      asUser(adminId, "admin").bootstrap({ resortId: otherResort, fractionsPerUnit: 10 }),
      asUser(adminId, "admin").bootstrap({ resortId: otherResort, fractionsPerUnit: 10 }),
    ]);

    // Pelo menos um precisa vencer; senão o teste passaria com estoque vazio.
    expect(outcomes.some(outcome => outcome.status === "fulfilled")).toBe(true);
    const [{ total }] = await db.select({ total: count() }).from(commercialFractions).where(eq(commercialFractions.resortId, otherResort));
    expect(Number(total)).toBe(50);
    const [{ uniq }] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(DISTINCT code) AS uniq FROM commercial_fractions WHERE resortId = ?", [otherResort],
    ).then(([r]) => r);
    expect(Number(uniq)).toBe(Number(total));
  });
});
