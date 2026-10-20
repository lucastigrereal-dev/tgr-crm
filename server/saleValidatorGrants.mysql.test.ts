import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, contractDocuments, contracts, customers, saleValidationEvents, saleValidatorGrants, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-C1 em MySQL real: administrativo autorizado (admin sempre; finance só com concessão vigente), sem gate de gerente, com atestado e segregação opcional.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("C1: administrativo autorizado valida a venda", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let adminId = 0, financeId = 0, finance2Id = 0, sellerId = 0;
  const previousEnv = { ...process.env };
  const router = async (id: number, role: "admin" | "finance" | "seller") => (await import("./routers/saleValidation")).saleValidationRouter.createCaller({ user: { id, role } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    const mk = async (name: string, role: "admin" | "finance" | "seller") => (await db.insert(users).values({ openId: `c1-${name}-${runId}`, name: `SYN ${name}`, role }).$returningId())[0]!.id;
    adminId = await mk("admin", "admin"); financeId = await mk("fin", "finance"); finance2Id = await mk("fin2", "finance"); sellerId = await mk("seller", "seller");
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  async function seedReady(label: string) {
    const [customer] = await db.insert(customers).values({ fullName: `SYN C1 ${label} ${runId}`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `C1-${label}-${runId}`, customerId: customer.id, status: "pending_signature", totalAmount: "1000.00", signedAt: new Date(Date.now() - 60_000) } as never).$returningId();
    const [doc] = await db.insert(contractDocuments).values({ contractId: contract.id, category: "contrato", filename: "assinado.pdf", storageKey: `c1/${label}/assinado.pdf`, signed: true, signedArtifact: true }).$returningId();
    return { contractId: contract.id, documentId: doc.id };
  }

  it("financeiro sem concessão é recusado; admin concede; com concessão confere e valida; revogado volta a ser recusado", async () => {
    const { contractId, documentId } = await seedReady("g1");
    const fin = await router(financeId, "finance");
    await expect(fin.confirmPayment({ contractId, note: "comprovante ok" })).rejects.toThrow(/concessão/);
    expect((await fin.myAuthorization()).authorized).toBe(false);
    await expect(fin.grants.grant({ userId: financeId })).rejects.toThrow(); // financeiro não concede a si mesmo

    const admin = await router(adminId, "admin");
    const { id: grantId } = await admin.grants.grant({ userId: financeId, note: "SYN" });
    await expect(admin.grants.grant({ userId: financeId })).rejects.toThrow(/já tem concessão/);
    await expect(admin.grants.grant({ userId: sellerId })).rejects.toThrow(/financeiro/);
    expect((await fin.myAuthorization()).authorized).toBe(true);

    await fin.confirmPayment({ contractId, note: "comprovante conferido pelo administrativo", evidenceRef: "evidence/g1.png" });
    const result = await fin.validateSale({ contractId, signedDocumentId: documentId });
    expect(result).toMatchObject({ success: true, alreadyValidated: false });
    const final = (await db.select().from(saleValidationEvents).where(eq(saleValidationEvents.contractId, contractId))).find(step => step.step === "final_validated")!;
    expect(final.actorUserId).toBe(financeId);
    const after = JSON.parse(String(final.afterJson));
    expect(after.attestation).toMatch(/Declaro ter conferido/);
    expect(after.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

    await admin.grants.revoke({ grantId });
    expect((await fin.myAuthorization()).authorized).toBe(false);
    const other = await seedReady("g1b");
    await expect(fin.confirmPayment({ contractId: other.contractId, note: "comprovante ok" })).rejects.toThrow(/concessão/);
    const trail = await db.select().from(auditLogs).where(eq(auditLogs.entityType, "sale_validator_grant"));
    expect(trail.map(row => row.action)).toEqual(expect.arrayContaining(["granted", "revoked"]));
  });

  it("concessão vencida não vale; vendedor e service nunca", async () => {
    await db.insert(saleValidatorGrants).values({ userId: finance2Id, grantedByUserId: adminId, validFrom: new Date(Date.now() - 86_400_000), validUntil: new Date(Date.now() - 1000) } as never);
    expect((await (await router(finance2Id, "finance")).myAuthorization()).authorized).toBe(false);
    // Codex P2: concessão vencida (sem revogação) não bloqueia a renovação.
    const admin = await router(adminId, "admin");
    await admin.grants.grant({ userId: finance2Id, note: "renovação SYN" });
    expect((await (await router(finance2Id, "finance")).myAuthorization()).authorized).toBe(true);
    await expect(admin.grants.grant({ userId: finance2Id })).rejects.toThrow(/já tem concessão/);
    const { contractId } = await seedReady("g2");
    await expect((await router(sellerId, "seller")).confirmPayment({ contractId, note: "tentativa" })).rejects.toThrow();
  });

  it("segregação: desligada por padrão a mesma pessoa confere e valida; ligada, é recusada; só admin liga, com trilha", async () => {
    const admin = await router(adminId, "admin");
    expect((await admin.segregation.get()).enabled).toBe(false);
    const a = await seedReady("s1");
    await admin.confirmPayment({ contractId: a.contractId, note: "conferido por mim" });
    await expect(admin.validateSale({ contractId: a.contractId, signedDocumentId: a.documentId })).resolves.toMatchObject({ success: true });

    await expect((await router(financeId, "finance")).segregation.set({ enabled: true })).rejects.toThrow();
    await admin.segregation.set({ enabled: true });
    try {
      const b = await seedReady("s2");
      await admin.confirmPayment({ contractId: b.contractId, note: "conferido por mim" });
      await expect(admin.validateSale({ contractId: b.contractId, signedDocumentId: b.documentId })).rejects.toThrow(/SALE_SEGREGATION/);
      const otherAdminId = (await db.insert(users).values({ openId: `c1-admin2-${runId}`, name: "SYN admin2", role: "admin" }).$returningId())[0]!.id;
      await expect((await router(otherAdminId, "admin")).validateSale({ contractId: b.contractId, signedDocumentId: b.documentId })).resolves.toMatchObject({ success: true });
    } finally { await admin.segregation.set({ enabled: false }); }
  });
});
