import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { materializeSalesCommandSale, type SalesCommandSale } from "./salesCommandBridge";

// P-05: o seed da sala deixa o CRM pronto para a 1ª venda do Sales (empreendimento, UH, 10 cotas, política sale_terms), sem dado real.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const projectName = `SYN Piloto da sala ${runId}`;

describe.skipIf(!integrationUrl)("seed do piloto da sala em MySQL real", () => {
  let pool: mysql.Pool;

  beforeAll(() => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
  });
  afterAll(async () => { await pool?.end(); });

  const seed = (...extra: string[]) => spawnSync(process.execPath, ["scripts/pilot-seed-sala.mjs", "--project-name", projectName, ...extra], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env, DATABASE_URL: integrationUrl },
  });

  it("cria UH, 10 cotas e a política, e rodar de novo não duplica nada", async () => {
    const first = seed();
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ project: projectName, units: 1, fractions: 10, available: 10, saleTermsPolicies: 1, mappedToSales: false });
    expect(first.stdout).not.toContain("mysql://");
    const again = seed();
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ units: 1, fractions: 10, available: 10, saleTermsPolicies: 1 });
  });

  it("a 1ª venda do Sales entra sem configuração manual (mapeia por nome e usa a política do seed)", async () => {
    expect(seed().status).toBe(0);
    const event: SalesCommandSale = {
      eventId: `evt-${randomUUID()}`, eventName: "sale.ready_for_contract.v1", source: "sales-command", correlationId: `corr-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      project: { externalKey: `SYN-SALA-${runId}`, name: projectName, timezone: "America/Recife" },
      saleId: `sale-${randomUUID()}`, encounterId: `enc-${randomUUID()}`,
      customer: { name: `SYN-Casal ${runId}` },
      sale: {
        quotasCount: 2, vgvCents: 2_400_000, entryContractedCents: 240_000, entryReceivedCents: 120_000, entryInstallmentCount: 2,
        entrySchedule: [{ sequence: 1, amountCents: 120_000, dueDate: "2026-10-15" }, { sequence: 2, amountCents: 120_000, dueDate: "2026-11-15" }],
        firstBalanceDueInDays: 30, paymentMethods: ["PIX"],
      },
    };
    const db = drizzle({ client: pool });
    const result = await db.transaction(tx => materializeSalesCommandSale(tx, event));
    expect(result.replay).toBe(false);
    expect(result.fractionIds).toHaveLength(2);
    expect(result.installmentCount).toBe(2 + 12);
  });
});
