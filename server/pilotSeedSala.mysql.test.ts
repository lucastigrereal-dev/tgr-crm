import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { domainEvents, installments } from "../drizzle/schema";
import { eq } from "drizzle-orm";
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

  it("rodar de novo com outro número de parcelas é recusado (não ignora em silêncio) e a URL malformada não vaza", () => {
    const name = `SYN Parcelas ${runId}`;
    const base = ["scripts/pilot-seed-sala.mjs", "--project-name", name];
    const env = { ...process.env, DATABASE_URL: integrationUrl };
    expect(spawnSync(process.execPath, [...base, "--balance-installments", "12"], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env }).status).toBe(0);
    const conflict = spawnSync(process.execPath, [...base, "--balance-installments", "6"], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env });
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("12 parcelas");
    const bad = spawnSync(process.execPath, base, { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env, DATABASE_URL: "mysql://usuario:SENHA-SECRETA@host-invalido:abc/db" } });
    expect(bad.status).toBe(1);
    expect(`${bad.stdout}${bad.stderr}`).not.toContain("SENHA-SECRETA");
  });

  it("só cria cota nas UHs pedidas (UH alheia com prefixo parecido fica sem cota)", async () => {
    const name = `SYN Prefixo ${runId}`;
    await pool.query("INSERT INTO resorts (name, status) VALUES (?, 'active')", [name]);
    const [[resort]] = await pool.query("SELECT id FROM resorts WHERE name = ?", [name]) as [Array<{ id: number }>, unknown];
    await pool.query("INSERT INTO units (resortId, code, status) VALUES (?, 'SYN-UH-77', 'active')", [resort.id]);
    const result = spawnSync(process.execPath, ["scripts/pilot-seed-sala.mjs", "--project-name", name], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env, DATABASE_URL: integrationUrl } });
    expect(result.status).toBe(0);
    const [[alheia]] = await pool.query("SELECT COUNT(*) AS n FROM commercial_fractions f JOIN units u ON u.id = f.unitId WHERE u.resortId = ? AND u.code = 'SYN-UH-77'", [resort.id]) as [Array<{ n: number }>, unknown];
    expect(Number(alheia.n)).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ units: 2, fractions: 10 });
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
    // PKG-FIN-03: cada parcela nova vira um aviso "a receber" para o Financial, na mesma transação.
    const scheduled = (await db.select().from(domainEvents).where(eq(domainEvents.eventName, "installment.scheduled"))).map(row => JSON.parse(row.payload ?? "{}")).filter(payload => payload.contractId === result.contractId);
    // A entrada já recebida nasce paga e não é "a receber": os avisos cobrem exatamente as parcelas em aberto.
    const open = (await db.select().from(installments).where(eq(installments.contractId, result.contractId))).filter(row => row.status === "open");
    expect(open.length).toBeGreaterThan(0);
    expect(scheduled).toHaveLength(open.length);
    expect(scheduled.map(payload => payload.installmentId).sort()).toEqual(open.map(row => row.id).sort());
    expect(scheduled[0]).toMatchObject({ installmentId: expect.any(Number), customerId: expect.any(Number), amount: expect.stringMatching(/^\d+\.\d{2}$/), dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
});
