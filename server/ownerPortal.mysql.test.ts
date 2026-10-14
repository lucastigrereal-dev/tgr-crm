import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { billingRecords, contracts, customers, installments, ownerPortalLinks, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Portal do Proprietário (TSE #19, escopo mínimo) em MySQL real: link de leitura com hash, validade e revogação.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("portal do proprietário em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let ownerPortalRouter: typeof import("./routers/ownerPortal")["ownerPortalRouter"];
  let adminId: number;
  let customerId: number;
  let otherCustomerId: number;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ ownerPortalRouter } = await import("./routers/ownerPortal"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `portal-admin-${runId}`, name: "Admin portal", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Maria Sintética ${runId}`, documentNumber: `P${runId}`, email: `maria-${runId}@example.test`, status: "active" }).$returningId();
    [{ id: otherCustomerId }] = await db.insert(customers).values({ fullName: `Outro Sintético ${runId}`, status: "active" }).$returningId();
    const [active] = await db.insert(contracts).values({ number: `PORTAL-A-${runId}`, customerId, status: "active", totalAmount: "12000.00" }).$returningId();
    await db.insert(contracts).values({ number: `PORTAL-D-${runId}`, customerId, status: "draft", totalAmount: "500.00" });
    await db.insert(contracts).values({ number: `PORTAL-X-${runId}`, customerId: otherCustomerId, status: "active", totalAmount: "900.00" });
    const [paid] = await db.insert(installments).values({ contractId: active.id, sequence: 1, dueDate: new Date("2026-09-10T12:00:00Z"), amount: "1000.00", status: "paid", paidAt: new Date() }).$returningId();
    const [open] = await db.insert(installments).values({ contractId: active.id, sequence: 2, dueDate: new Date("2026-11-10T12:00:00Z"), amount: "1000.00", status: "open" }).$returningId();
    await db.insert(billingRecords).values({ installmentId: open.id, type: "pix", status: "generated", amount: "1000.00", dueDate: new Date("2026-11-10T12:00:00Z"), pixCopyPaste: "PIX-SINTETICO", idempotencyKey: `portal-${runId}-open` });
    await db.insert(billingRecords).values({ installmentId: paid.id, type: "boleto", status: "paid", amount: "1000.00", dueDate: new Date("2026-09-10T12:00:00Z"), bankSlipUrl: "https://example.test/pago", idempotencyKey: `portal-${runId}-paid` });
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const admin = () => ownerPortalRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
  const visitor = () => ownerPortalRouter.createCaller({ user: null } as never);
  const tokenOf = (path: string) => path.replace("/portal/", "");

  it("link mostra só os contratos do associado (sem rascunho), parcelas e a 2ª via da parcela em aberto; sem dado pessoal", async () => {
    const link = await admin().createLink({ customerId, days: 7 });
    const [stored] = await db.select().from(ownerPortalLinks).where(eq(ownerPortalLinks.id, link.linkId));
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenHash).not.toContain(tokenOf(link.path)); // o token não fica no banco

    const view = await visitor().view({ token: tokenOf(link.path) });
    expect(view.firstName).toBe("Maria");
    expect(view.contracts.map(contract => contract.number)).toEqual([`PORTAL-A-${runId}`]);
    const [first, second] = view.contracts[0]!.installments;
    expect(first).toMatchObject({ sequence: 1, status: "paid", billing: null });
    expect(second).toMatchObject({ sequence: 2, status: "open", billing: { type: "pix", pixCopyPaste: "PIX-SINTETICO" } });
    const body = JSON.stringify(view);
    expect(body).not.toContain(`P${runId}`);
    expect(body).not.toContain("example.test");

    const [afterView] = await db.select().from(ownerPortalLinks).where(eq(ownerPortalLinks.id, link.linkId));
    expect(afterView.accessCount).toBe(1);
  });

  it("revogado, expirado ou token inventado: mesma recusa", async () => {
    const link = await admin().createLink({ customerId });
    await admin().revokeLink({ linkId: link.linkId });
    await expect(visitor().view({ token: tokenOf(link.path) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin().revokeLink({ linkId: link.linkId })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const expiring = await admin().createLink({ customerId });
    await db.update(ownerPortalLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(ownerPortalLinks.id, expiring.linkId));
    await expect(visitor().view({ token: tokenOf(expiring.path) })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(visitor().view({ token: "A".repeat(43) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(visitor().view({ token: "curto" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const listed = await admin().listLinks({ customerId });
    expect(listed.find(row => row.id === link.linkId)?.active).toBe(false);
  });

  it("só a administração gera link; validade acima de 90 dias é recusada", async () => {
    const seller = ownerPortalRouter.createCaller({ user: { id: adminId, role: "seller" } } as never);
    await expect(seller.createLink({ customerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin().createLink({ customerId, days: 91 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
