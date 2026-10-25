import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { contracts, customers, financialTransactions, installments, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// M-A07-04 / QA-05: pagamento misto em centavos. Dois meios (pix e boleto) no mesmo contrato; a soma e o saldo fecham ao centavo no banco
// (decimal, não ponto flutuante) e nenhuma diferença é perdoada em silêncio: a baixa lança exatamente o saldo aberto da parcela.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("QA-05: pagamento misto em centavos", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let financeRouter: typeof import("./routers/finance")["financeRouter"];
  let adminId: number;
  const previousEnv = { ...process.env };
  const finance = () => financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ financeRouter } = await import("./routers/finance"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `qa05-fin-${runId}`, name: "Financeiro SYN", role: "admin" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const sums = async (contractId: number) => {
    const [row] = (await db.execute(sql`SELECT CAST(COALESCE(SUM(paidAmount),0) AS CHAR) AS paid, CAST(COALESCE(SUM(amount),0) AS CHAR) AS contracted FROM installments WHERE contractId = ${contractId}`))[0] as unknown as Array<{ paid: string; contracted: string }>;
    const [ledger] = (await db.execute(sql`SELECT CAST(COALESCE(SUM(amount),0) AS CHAR) AS ledger FROM financial_transactions WHERE contractId = ${contractId} AND type = 'income'`))[0] as unknown as Array<{ ledger: string }>;
    return { paid: row!.paid, contracted: row!.contracted, ledger: ledger!.ledger };
  };

  it("pix + boleto em centavos (1000.01 em 3 parcelas): soma recebida, razão e saldo batem exatos", async () => {
    const [customer] = await db.insert(customers).values({ fullName: `Cliente QA05 ${runId}`, email: `qa05.${runId}@example.test`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `QA05-${runId}`, customerId: customer.id, status: "active", totalAmount: "1000.01" } as never).$returningId();
    const amounts = ["333.34", "333.34", "333.33"];
    const ids: number[] = [];
    for (const [i, amount] of amounts.entries()) {
      const [row] = await db.insert(installments).values({ contractId: contract.id, sequence: i + 1, dueDate: new Date(`2026-1${i}-10T12:00:00Z`), amount, status: "open", paidAmount: "0.00" }).$returningId();
      ids.push(row.id);
    }
    await finance().markInstallmentPaid({ id: ids[0]!, paymentMethod: "pix" });
    await finance().markInstallmentPaid({ id: ids[1]!, paymentMethod: "boleto" });
    expect(await sums(contract.id)).toEqual({ paid: "666.68", contracted: "1000.01", ledger: "666.68" });
    // Saldo = contratado − recebido, em centavos: a 3ª parcela segue aberta com o valor exato e a diferença não some.
    const [open] = await db.select().from(installments).where(eq(installments.id, ids[2]!));
    expect(open).toMatchObject({ status: "open", paidAmount: "0.00", amount: "333.33" });
    await finance().markInstallmentPaid({ id: ids[2]!, paymentMethod: "pix" });
    expect(await sums(contract.id)).toEqual({ paid: "1000.01", contracted: "1000.01", ledger: "1000.01" });
    const methods = (await db.select({ method: installments.paymentMethod }).from(installments).where(eq(installments.contractId, contract.id))).map(r => r.method).sort();
    expect(methods).toEqual(["boleto", "pix", "pix"]);
  });

  it("parcela com parte já recebida: a baixa lança só o saldo aberto (nada perdoado nem duplicado)", async () => {
    const [customer] = await db.insert(customers).values({ fullName: `Cliente QA05b ${runId}`, email: `qa05b.${runId}@example.test`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `QA05B-${runId}`, customerId: customer.id, status: "active", totalAmount: "100.10" } as never).$returningId();
    const [row] = await db.insert(installments).values({ contractId: contract.id, sequence: 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount: "100.10", status: "open", paidAmount: "0.10" }).$returningId();
    await finance().markInstallmentPaid({ id: row.id, paymentMethod: "boleto" });
    expect(await sums(contract.id)).toEqual({ paid: "100.10", contracted: "100.10", ledger: "100.00" }); // razão = 100.10 − 0.10 já recebido
    const txs = await db.select().from(financialTransactions).where(eq(financialTransactions.contractId, contract.id));
    expect(txs).toHaveLength(1);
  });
});
