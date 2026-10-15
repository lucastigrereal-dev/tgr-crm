import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, customers, users, vouchers } from "../drizzle/schema";
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
    const issued = await caller().vouchers.issue({ customerId, description: "Jantar para 2", costAmount: 180.5, expiresAt: today, requestId: randomUUID() });
    expect(issued.code).toMatch(/^[A-Z2-9]{8}$/);
    let [row] = (await caller().vouchers.listByCustomer({ customerId })).vouchers;
    expect(row).toMatchObject({ code: issued.code, costAmount: 180.5, expiresAt: today, state: "issued" });

    const used = await caller().vouchers.redeem({ code: ` ${issued.code.slice(0, 4).toLowerCase()}-${issued.code.slice(4)} `, note: "Usou no restaurante" });
    expect(used).toMatchObject({ voucherId: issued.voucherId, customerId });
    [row] = (await caller().vouchers.listByCustomer({ customerId })).vouchers;
    expect(row).toMatchObject({ state: "redeemed", redeemNote: "Usou no restaurante" });
    await expect(caller().vouchers.redeem({ code: issued.code })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller("seller").vouchers.cancel({ id: issued.voucherId, reason: "Desistiu do brinde" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("baixas ao mesmo tempo no mesmo código: só uma passa", async () => {
    const issued = await caller().vouchers.issue({ customerId, description: "Passeio de buggy", costAmount: 90, requestId: randomUUID() });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => caller().vouchers.redeem({ code: issued.code })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason.code)).toEqual(["CONFLICT", "CONFLICT", "CONFLICT", "CONFLICT"]);
  });

  it("vencido não dá baixa, cancelado não volta, validade no passado é recusada e recepção não cancela", async () => {
    await expect(caller().vouchers.issue({ customerId, description: "Brinde vencido", expiresAt: "2020-01-01", requestId: randomUUID() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const old = await caller().vouchers.issue({ customerId, description: "Brinde que venceu", costAmount: 40, requestId: randomUUID() });
    await db.update(vouchers).set({ expiresAt: "2020-01-01" }).where(eq(vouchers.id, old.voucherId));
    await expect(caller().vouchers.redeem({ code: old.code })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("venceu") });
    await expect(caller("seller").vouchers.cancel({ id: old.voucherId, reason: "Casal não veio" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const toCancel = await caller().vouchers.issue({ customerId, description: "Brinde cancelado", costAmount: 25, requestId: randomUUID() });
    await expect(caller("service").vouchers.cancel({ id: toCancel.voucherId, reason: "Casal desistiu" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller("seller").vouchers.cancel({ id: toCancel.voucherId, reason: "Casal desistiu" });
    await expect(caller().vouchers.redeem({ code: toCancel.code })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const states = Object.fromEntries((await caller().vouchers.listByCustomer({ customerId })).vouchers.map(row => [row.description, row.state]));
    expect(states).toMatchObject({ "Brinde que venceu": "expired", "Brinde cancelado": "cancelled", "Jantar para 2": "redeemed" });
  });

  it("o resumo do período soma custo por situação e o voucher só vale para a ficha do próprio associado", async () => {
    const summary = await caller().vouchers.summary({ startDate: today, endDate: today });
    expect(summary.redeemed.count).toBeGreaterThanOrEqual(2);
    expect(summary.expired.cost).toBeGreaterThanOrEqual(40);
    expect(summary.total.count).toBe(summary.issued.count + summary.redeemed.count + summary.cancelled.count + summary.expired.count);
    // Parceiro que entrega o brinde: aparece na ficha e no resumo, com o prometido e o usado.
    const partnerName = `Restaurante Sintético ${runId}`;
    const [{ id: partnerCustomer }] = await db.insert(customers).values({ fullName: `Casal Parceiro ${runId}`, status: "active" }).$returningId();
    const partnerRequest = randomUUID();
    const dinner = await caller().vouchers.issue({ customerId: partnerCustomer, description: "Jantar do parceiro", partnerName, costAmount: 80, requestId: partnerRequest });
    await caller().vouchers.issue({ customerId: partnerCustomer, description: "Almoço do parceiro", partnerName, costAmount: 50, requestId: randomUUID() });
    await caller().vouchers.redeem({ code: dinner.code });
    expect((await caller().vouchers.listByCustomer({ customerId: partnerCustomer })).vouchers.find(row => row.id === dinner.voucherId)?.partnerName).toBe(partnerName);
    const byPartner = (await caller().vouchers.summary({ startDate: today, endDate: today })).partners.find(row => row.partnerName === partnerName);
    expect(byPartner).toEqual({ partnerName, count: 2, cost: 130, redeemedCount: 1, redeemedCost: 80 });
    await expect(caller().vouchers.issue({ customerId: partnerCustomer, description: "Jantar do parceiro", partnerName: "Outro parceiro", costAmount: 80, requestId: partnerRequest })).rejects.toMatchObject({ code: "CONFLICT" });
    const [{ id: other }] = await db.insert(customers).values({ fullName: `Outro Casal ${runId}`, status: "active" }).$returningId();
    await expect(caller().vouchers.issue({ customerId: other, captureId: 2147483000, description: "Brinde errado", requestId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("resumo sem datas usa o mês corrente no fuso do projeto e soma o período inteiro, além de uma página de leitura", async () => {
    const defaults = await caller().vouchers.summary({});
    expect(defaults).toMatchObject({ startDate: `${today.slice(0, 7)}-01`, endDate: today });
    const day = new Date(Date.UTC(2001, 0, 1 + Math.floor(Math.random() * 360), 15));
    const dayKey = day.toISOString().slice(0, 10);
    const count = 5100;
    for (let start = 0; start < count; start += 1000) {
      await db.insert(vouchers).values(Array.from({ length: Math.min(1000, count - start) }, (_, index) => ({ code: `T${runId}${start + index}`.slice(0, 16), customerId, description: "Brinde sintético de carga", costAmount: "1.25", issuedByUserId: userId, issuedAt: day, status: "cancelled" as const, cancelledAt: day, cancelReason: "Carga sintética" })));
    }
    const summary = await caller().vouchers.summary({ startDate: dayKey, endDate: dayKey });
    expect(summary.cancelled).toEqual({ count, cost: 6375 });
    expect(summary.total).toEqual({ count, cost: 6375 });

    // Histórico grande: um voucher válido antigo continua aparecendo na ficha, à frente de vencidos mais novos, e a resposta avisa o corte.
    await db.insert(vouchers).values(Array.from({ length: 210 }, (_, index) => ({ code: `E${runId}${index}`, customerId, description: "Brinde vencido sintético", costAmount: "1.00", expiresAt: "2020-01-01", issuedByUserId: userId })));
    const [{ id: oldValid }] = await db.insert(vouchers).values({ code: `V${runId}`, customerId, description: "Brinde válido antigo", costAmount: "10.00", issuedByUserId: userId, issuedAt: new Date("2000-06-01T15:00:00Z") }).$returningId();
    const list = await caller().vouchers.listByCustomer({ customerId });
    expect(list.truncated).toBe(true);
    expect(list.total).toBeGreaterThan(count);
    expect(list.vouchers).toHaveLength(201);
    expect(list.vouchers.some(row => row.id === oldValid && row.state === "issued")).toBe(true);
  });

  it("reenviar a mesma emissão devolve o mesmo voucher, em sequência ou ao mesmo tempo; outro associado com o mesmo pedido é recusado", async () => {
    const requestId = randomUUID();
    const first = await caller().vouchers.issue({ customerId, description: "Café da manhã", costAmount: 30, requestId });
    const again = await Promise.all([1, 2, 3].map(() => caller().vouchers.issue({ customerId, description: "Café da manhã", costAmount: 30, requestId })));
    expect(again).toEqual([first, first, first]);
    // Auditoria que falhou na primeira vez: o reenvio grava, sem duplicar.
    await db.delete(auditLogs).where(eq(auditLogs.idempotencyKey, `voucher_issued:${first.voucherId}`));
    await caller().vouchers.issue({ customerId, description: "Café da manhã", costAmount: 30, requestId });
    await caller().vouchers.issue({ customerId, description: "Café da manhã", costAmount: 30, requestId });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `voucher_issued:${first.voucherId}`))).toHaveLength(1);
    const parallelId = randomUUID();
    const parallel = await Promise.all([1, 2, 3].map(() => caller().vouchers.issue({ customerId, description: "Massagem", costAmount: 120, requestId: parallelId })));
    expect(new Set(parallel.map(result => result.voucherId)).size).toBe(1);
    expect((await db.select().from(vouchers).where(eq(vouchers.requestId, parallelId)))).toHaveLength(1);
    const [{ id: other }] = await db.insert(customers).values({ fullName: `Outro Casal ${runId}`, status: "active" }).$returningId();
    await expect(caller().vouchers.issue({ customerId: other, description: "Café da manhã", requestId })).rejects.toMatchObject({ code: "CONFLICT" });
    // Emissão feita no último dia de validade e reenviada depois da meia-noite: devolve o voucher já gravado, sem recusar a data.
    const lateId = randomUUID();
    const late = await caller().vouchers.issue({ customerId, description: "Jantar", expiresAt: today, requestId: lateId });
    await db.update(vouchers).set({ expiresAt: "2000-01-01" }).where(eq(vouchers.id, late.voucherId));
    await expect(caller().vouchers.issue({ customerId, description: "Jantar", expiresAt: "2000-01-01", requestId: lateId })).resolves.toEqual(late);
    // Reenvio com o brinde editado é recusado, em vez de dizer que emitiu o que foi digitado agora.
    await expect(caller().vouchers.issue({ customerId, description: "Jantar para 4", expiresAt: "2000-01-01", requestId: lateId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().vouchers.issue({ customerId, description: "Jantar", costAmount: 99, expiresAt: "2000-01-01", requestId: lateId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().vouchers.issue({ customerId, description: "Jantar", expiresAt: "2000-01-01", requestId: randomUUID() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("mais de 200 válidos: todos aparecem na ficha; baixa repetida grava a auditoria que faltou; a ficha de captação liga o brinde", async () => {
    const [{ id: many }] = await db.insert(customers).values({ fullName: `Casal Muitos ${runId}`, status: "active" }).$returningId();
    await db.insert(vouchers).values(Array.from({ length: 230 }, (_, index) => ({ code: `M${runId}${index}`, customerId: many, description: "Brinde válido sintético", costAmount: "1.00", issuedByUserId: userId })));
    await db.insert(vouchers).values(Array.from({ length: 205 }, (_, index) => ({ code: `H${runId}${index}`, customerId: many, description: "Brinde usado sintético", costAmount: "1.00", status: "redeemed" as const, redeemedAt: new Date(), issuedByUserId: userId })));
    const list = await caller().vouchers.listByCustomer({ customerId: many });
    expect(list.validCount).toBe(230);
    expect(list.vouchers.filter(row => row.state === "issued")).toHaveLength(230);
    expect(list.vouchers).toHaveLength(430);
    expect(list).toMatchObject({ total: 435, truncated: true });

    const issued = await caller().vouchers.issue({ customerId, description: "Spa", costAmount: 50, requestId: randomUUID() });
    await caller().vouchers.redeem({ code: issued.code });
    await db.delete(auditLogs).where(eq(auditLogs.idempotencyKey, `voucher_redeemed:${issued.voucherId}`));
    await expect(caller().vouchers.redeem({ code: issued.code })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `voucher_redeemed:${issued.voucherId}`))).toHaveLength(1);
    const toCancel = await caller().vouchers.issue({ customerId, description: "Passeio", costAmount: 20, requestId: randomUUID() });
    await caller("seller").vouchers.cancel({ id: toCancel.voucherId, reason: "Casal desistiu" });
    await db.delete(auditLogs).where(eq(auditLogs.idempotencyKey, `voucher_cancelled:${toCancel.voucherId}`));
    await expect(caller("seller").vouchers.cancel({ id: toCancel.voucherId, reason: "Casal desistiu" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `voucher_cancelled:${toCancel.voucherId}`))).toHaveLength(1);

    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId, captureLocation: "Recepção sintética" } as never).$returningId();
    expect((await caller().vouchers.captureOptions({ customerId })).captures.map(row => row.id)).toContain(captureId);
    // Mais de uma página de fichas: a mais antiga continua alcançável pela página seguinte.
    const [{ id: busy }] = await db.insert(customers).values({ fullName: `Casal Muitas Fichas ${runId}`, status: "active" }).$returningId();
    const [{ id: oldest }] = await db.insert(captureRecords).values({ customerId: busy, captureLocation: "Ficha sintética antiga" } as never).$returningId();
    for (let index = 0; index < 59; index += 1) await db.insert(captureRecords).values({ customerId: busy, captureLocation: `Ficha sintética ${index}` } as never);
    const firstPage = await caller().vouchers.captureOptions({ customerId: busy });
    expect(firstPage.captures).toHaveLength(50);
    expect(firstPage.captures.map(row => row.id)).not.toContain(oldest);
    const secondPage = await caller().vouchers.captureOptions({ customerId: busy, beforeId: firstPage.nextBeforeId! });
    expect(secondPage.captures).toHaveLength(10);
    expect(secondPage.captures.map(row => row.id)).toContain(oldest);
    expect(secondPage.nextBeforeId).toBeNull();
    await expect(caller().vouchers.issue({ customerId: busy, captureId: oldest, description: "Brinde da ficha antiga", requestId: randomUUID() })).resolves.toMatchObject({ voucherId: expect.any(Number) });
    const linked = await caller().vouchers.issue({ customerId, captureId, description: "Jantar do tour", costAmount: 80, requestId: randomUUID() });
    expect((await caller().vouchers.listByCustomer({ customerId })).vouchers.find(row => row.id === linked.voucherId)?.captureId).toBe(captureId);
  });
});
