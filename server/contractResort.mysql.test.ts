import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, commercialFractions, contracts, customers, opportunities, proposals, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-PK-04 / ADR-011: o contrato grava o empreendimento. Prova no MySQL real: criação manual pela cota grava resortId,
// o backfill da migração 0059 preenche contratos antigos (por cota e por captação) e a migração desfaz limpo.
// Dados 100% sintéticos; cada valor único leva o runId.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
vi.mock("./storage", () => ({ storagePut: async (key: string) => ({ key, url: `https://storage.example/${key}` }) }));

const root = path.resolve(import.meta.dirname, "..");
const statements = (file: string) => readFileSync(path.join(root, file), "utf8").split("--> statement-breakpoint").map(item => item.trim()).filter(Boolean);

describe.skipIf(!integrationUrl)("resort gravado no contrato em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let contractsRouter: typeof import("./routers/contracts")["contractsRouter"];
  let adminId: number;
  let customerId: number;
  const previousEnv = { ...process.env };
  const admin = () => contractsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ contractsRouter } = await import("./routers/contracts"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `cr-admin-${runId}`, name: "Admin Sintético", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `SYN Resort ${runId}`, email: `syn.resort.${runId}@example.test`, status: "active" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  async function resortWithFraction(label: string) {
    const [resort] = await db.insert(resorts).values({ name: `Resort ${label} ${runId}` } as never).$returningId();
    const [unit] = await db.insert(units).values({ resortId: resort.id, code: `U-CR-${label}-${runId}` }).$returningId();
    const [fraction] = await db.insert(commercialFractions).values({ resortId: resort.id, unitId: unit.id, code: `F-CR-${label}-${runId}`, sequence: 1, status: "available", listPrice: "3000.00" }).$returningId();
    return { resortId: resort.id, fractionId: fraction.id };
  }

  const backfill = () => statements("drizzle/0059_contracts_resort_id.sql").filter(item => item.startsWith("UPDATE"));

  it("contracts.create pela cota grava o empreendimento da cota", async () => {
    const { resortId, fractionId } = await resortWithFraction("A");
    const { id } = await admin().create({ number: `CR-A-${runId}`, customerId, fractionId, totalAmount: 3000, firstDueDate: "2026-12-10", installmentCount: 3, usageModel: "fixed_week", status: "draft" });
    const [row] = await db.select({ resortId: contracts.resortId }).from(contracts).where(eq(contracts.id, id));
    expect(row?.resortId).toBe(resortId);
  });

  it("backfill preenche contrato antigo pela cota e pela captação, e deixa sem origem em branco", async () => {
    const { resortId, fractionId } = await resortWithFraction("B");
    const { id: byFraction } = await admin().create({ number: `CR-B-${runId}`, customerId, fractionId, totalAmount: 3000, firstDueDate: "2026-12-10", installmentCount: 3, usageModel: "fixed_week", status: "draft" });

    const [captureResort] = await db.insert(resorts).values({ name: `Resort Captação ${runId}` } as never).$returningId();
    const [opportunity] = await db.insert(opportunities).values({ customerId, title: `Opp CR ${runId}`, sellerId: adminId } as never).$returningId();
    const [proposal] = await db.insert(proposals).values({ opportunityId: opportunity.id, reference: `P-CR-${runId}`, productDescription: "Semana fixa", totalAmount: "5000.00", downPaymentAmount: "500.00", installmentCount: 3 }).$returningId();
    await db.insert(captureRecords).values({ customerId, resortId: captureResort.id, opportunityId: opportunity.id } as never);
    const [byCapture] = await db.insert(contracts).values({ number: `CR-C-${runId}`, customerId, proposalId: proposal.id, usageModel: "fixed_week", status: "draft", totalAmount: "5000.00" }).$returningId();
    const [orphan] = await db.insert(contracts).values({ number: `CR-D-${runId}`, customerId, usageModel: "fixed_week", status: "draft", totalAmount: "1000.00" }).$returningId();

    await db.update(contracts).set({ resortId: null }).where(eq(contracts.id, byFraction));
    for (const statement of backfill()) await db.execute(sql.raw(statement));
    // Rodar de novo não muda nada (idempotente).
    for (const statement of backfill()) await db.execute(sql.raw(statement));

    const resortOf = async (id: number) => (await db.select({ resortId: contracts.resortId }).from(contracts).where(eq(contracts.id, id)))[0]?.resortId;
    expect(await resortOf(byFraction)).toBe(resortId);
    expect(await resortOf(byCapture.id)).toBe(captureResort.id);
    expect(await resortOf(orphan.id)).toBeNull();
  });

  it("backfill: captação com mais de um empreendimento (mesmo com mais de 20 registros) deixa o contrato sem empreendimento", async () => {
    // Captação ambígua (25 registros num empreendimento e 1 em outro): nenhum empreendimento é escolhido. A criação manual usa a mesma regra (selectDistinct sem limite).
    const [resortOne] = await db.insert(resorts).values({ name: `Resort U1 ${runId}` } as never).$returningId();
    const [resortTwo] = await db.insert(resorts).values({ name: `Resort U2 ${runId}` } as never).$returningId();
    const [opportunity] = await db.insert(opportunities).values({ customerId, title: `Opp U ${runId}`, sellerId: adminId } as never).$returningId();
    const [proposal] = await db.insert(proposals).values({ opportunityId: opportunity.id, reference: `P-U-${runId}`, productDescription: "Semana fixa", totalAmount: "5000.00", downPaymentAmount: "500.00", installmentCount: 3 }).$returningId();
    for (let i = 0; i < 25; i += 1) await db.insert(captureRecords).values({ customerId, resortId: resortOne.id, opportunityId: opportunity.id } as never);
    await db.insert(captureRecords).values({ customerId, resortId: resortTwo.id, opportunityId: opportunity.id } as never);
    const [contract] = await db.insert(contracts).values({ number: `CR-U-${runId}`, customerId, proposalId: proposal.id, usageModel: "fixed_week", status: "draft", totalAmount: "5000.00" }).$returningId();
    for (const statement of backfill()) await db.execute(sql.raw(statement));
    const [row] = await db.select({ resortId: contracts.resortId }).from(contracts).where(eq(contracts.id, contract.id));
    expect(row?.resortId).toBeNull();
  });

  it("a migração 0059 sobe e desce limpo em banco descartável, e sobe de novo", async () => {
    const scratch = `tgr_pk04_${runId}`;
    const url = new URL(integrationUrl!);
    const admin = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), multipleStatements: false });
    try {
      await admin.query(`CREATE DATABASE \`${scratch}\``);
      await admin.query(`USE \`${scratch}\``);
      await admin.query("CREATE TABLE `resorts` (`id` int AUTO_INCREMENT PRIMARY KEY)");
      await admin.query("CREATE TABLE `contracts` (`id` int AUTO_INCREMENT PRIMARY KEY)");
      await admin.query("CREATE TABLE `__drizzle_migrations` (`id` int AUTO_INCREMENT PRIMARY KEY, `hash` text NOT NULL, `created_at` bigint)");
      await admin.query("INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES ('x', 1792181487893), ('y', 1792067221513)");
      const control = async () => ((await admin.query("SELECT `created_at` FROM `__drizzle_migrations`"))[0] as unknown[]).length;
      const up = statements("drizzle/0059_contracts_resort_id.sql").filter(item => item.startsWith("ALTER") || item.startsWith("CREATE"));
      const down = statements("docs/rollback/0059_contracts_resort_id.down.sql").map(item => item.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").trim()).filter(Boolean);
      const columns = async () => ((await admin.query("SHOW COLUMNS FROM `contracts` LIKE 'resortId'"))[0] as unknown[]).length;
      for (const statement of up) await admin.query(statement);
      expect(await columns()).toBe(1);
      for (const statement of down) await admin.query(statement);
      expect(await columns()).toBe(0);
      // A linha da 0059 sai da tabela de controle (senão o próximo deploy pularia a migração); a anterior fica.
      expect(await control()).toBe(1);
      for (const statement of up) await admin.query(statement);
      expect(await columns()).toBe(1);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS \`${scratch}\``);
      await admin.end();
    }
  });
});
