import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { customers, users, vouchers } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { localDateInTimezone } from "./saleTermsPolicy";

// Voucher/brinde (TSE #31) em MySQL real: emissão com custo e validade, baixa única, cancelamento com motivo, vencido calculado.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("vouchers e brindes em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let userId: number;
  let customerId: number;
  const previousEnv = { ...process.env };
  const today = localDateInTimezone(new Date(), "America/Recife");

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `vouchers-${runId}`, name: "Recepção vouchers", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Voucher ${runId}`, status: "active" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const caller = (role = "service") => appRouter.createCaller({ user: { id: userId, role } } as never);

  it("emite com custo e validade, dá baixa uma vez só pelo código e não deixa cancelar o que foi usado", async () => {
    const issued = await caller().vouchers.issue({ customerId, description: "Jantar para 2", costAmount: 180.5, expiresAt: today });
    expect(issued.code).toMatch(/^[A-Z2-9]{8}$/);
    let [row] = await caller().vouchers.listByCustomer({ customerId });
    expect(row).toMatchObject({ code: issued.code, costAmount: 180.5, expiresAt: today, state: "issued" });

    const used = await caller().vouchers.redeem({ code: ` ${issued.code.slice(0, 4).toLowerCase()}-${issued.code.slice(4)} `, note: "Usou no restaurante" });
    expect(used).toMatchObject({ voucherId: issued.voucherId, customerId });
    [row] = await caller().vouchers.listByCustomer({ customerId });
    expect(row).toMatchObject({ state: "redeemed", redeemNote: "Usou no restaurante" });
    await expect(caller().vouchers.redeem({ code: issued.code })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller("seller").vouchers.cancel({ id: issued.voucherId, reason: "Desistiu do brinde" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("baixas ao mesmo tempo no mesmo código: só uma passa", async () => {
    const issued = await caller().vouchers.issue({ customerId, description: "Passeio de buggy", costAmount: 90 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => caller().vouchers.redeem({ code: issued.code })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason.code)).toEqual(["CONFLICT", "CONFLICT", "CONFLICT", "CONFLICT"]);
  });

  it("vencido não dá baixa, cancelado não volta, validade no passado é recusada e recepção não cancela", async () => {
    await expect(caller().vouchers.issue({ customerId, description: "Brinde vencido", expiresAt: "2020-01-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const old = await caller().vouchers.issue({ customerId, description: "Brinde que venceu", costAmount: 40 });
    await db.update(vouchers).set({ expiresAt: "2020-01-01" }).where(eq(vouchers.id, old.voucherId));
    await expect(caller().vouchers.redeem({ code: old.code })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("venceu") });

    const toCancel = await caller().vouchers.issue({ customerId, description: "Brinde cancelado", costAmount: 25 });
    await expect(caller("service").vouchers.cancel({ id: toCancel.voucherId, reason: "Casal desistiu" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller("seller").vouchers.cancel({ id: toCancel.voucherId, reason: "Casal desistiu" });
    await expect(caller().vouchers.redeem({ code: toCancel.code })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const states = Object.fromEntries((await caller().vouchers.listByCustomer({ customerId })).map(row => [row.description, row.state]));
    expect(states).toMatchObject({ "Brinde que venceu": "expired", "Brinde cancelado": "cancelled", "Jantar para 2": "redeemed" });
  });

  it("o resumo do período soma custo por situação e o voucher só vale para a ficha do próprio associado", async () => {
    const summary = await caller().vouchers.summary({ startDate: today, endDate: today });
    expect(summary.redeemed.count).toBeGreaterThanOrEqual(2);
    expect(summary.expired.cost).toBeGreaterThanOrEqual(40);
    expect(summary.total.count).toBe(summary.issued.count + summary.redeemed.count + summary.cancelled.count + summary.expired.count);
    const [{ id: other }] = await db.insert(customers).values({ fullName: `Outro Casal ${runId}`, status: "active" }).$returningId();
    await expect(caller().vouchers.issue({ customerId: other, captureId: 2147483000, description: "Brinde errado" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
