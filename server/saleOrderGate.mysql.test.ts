import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { contractDocuments, contracts, customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-B1 em MySQL real: comprovante + documentação conferidos ANTES de gerar contrato; flag desligada por padrão. Dados SYN-.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
vi.mock("./storage", () => ({ storagePut: async (key: string) => ({ key, url: `https://storage.example/${key}` }), storageReadBytes: async () => Buffer.from("x") }));
const pdf = Buffer.from("%PDF-1.4 SYN conteudo de teste").toString("base64");

describe.skipIf(!integrationUrl)("B1: ordem da formalização", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let adminId = 0, sellerId = 0, customerId = 0;
  const previousEnv = { ...process.env };
  const contractsApi = async (id: number, role: "admin" | "seller") => (await import("./routers/contracts")).contractsRouter.createCaller({ user: { id, role } } as never);
  const saleApi = async (id: number, role: "admin" | "seller") => (await import("./routers/saleValidation")).saleValidationRouter.createCaller({ user: { id, role } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    adminId = (await db.insert(users).values({ openId: `b1-admin-${runId}`, name: "SYN admin", role: "admin" }).$returningId())[0]!.id;
    sellerId = (await db.insert(users).values({ openId: `b1-seller-${runId}`, name: "SYN seller", role: "seller" }).$returningId())[0]!.id;
    customerId = (await db.insert(customers).values({ fullName: `SYN B1 ${runId}`, status: "active" }).$returningId())[0]!.id;
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });
  const newContract = async (label: string, createdAt?: Date) =>
    (await db.insert(contracts).values({ number: `B1-${label}-${runId}`, customerId, usageModel: "fixed_week", status: "pending_signature", totalAmount: "1000.00", ...(createdAt ? { createdAt } : {}) } as never).$returningId())[0]!.id;
  const upload = async (contractId: number, category = "Contrato") => (await contractsApi(sellerId, "seller")).uploadDocument({ contractId, category, filename: "contrato.pdf", contentType: "application/pdf", base64: pdf });

  it("desligado por padrão: documento de contrato é aceito sem conferência", async () => {
    delete process.env.SALE_ORDER_GATE_ENABLED;
    await expect(upload(await newContract("off"))).resolves.toMatchObject({ id: expect.any(Number) });
  });

  describe("ligado", () => {
    beforeAll(() => { process.env.SALE_ORDER_GATE_ENABLED = "true"; });
    afterAll(() => { delete process.env.SALE_ORDER_GATE_ENABLED; delete process.env.SALE_ORDER_GATE_SINCE; });

    it("recusa documento de contrato até comprovante E documentação conferidos; comprovante (outra categoria) passa; depois das duas conferências passa", async () => {
      const contractId = await newContract("on1");
      await expect(upload(contractId)).rejects.toThrow(/SALE_ORDER_GATE.*comprovante e documentação/);
      await expect(upload(contractId, "Comprovante")).resolves.toMatchObject({ id: expect.any(Number) });
      const admin = await saleApi(adminId, "admin");
      await admin.confirmPayment({ contractId, note: "comprovante conferido" });
      await expect(upload(contractId)).rejects.toThrow(/documentação/);
      expect((await admin.getValidationStatus({ contractId })).orderGate).toMatchObject({ enabled: true, receiptConferred: true, documentsConferred: false, generationAllowed: false });
      await admin.confirmDocuments({ contractId, note: "documentação conferida" });
      expect(await admin.confirmDocuments({ contractId, note: "de novo" })).toMatchObject({ alreadyConfirmed: true });
      await expect(upload(contractId)).resolves.toMatchObject({ id: expect.any(Number) });
    });

    it("vendedor não confere documentação", async () => {
      const contractId = await newContract("on2");
      await expect((await saleApi(sellerId, "seller")).confirmDocuments({ contractId, note: "tentativa" })).rejects.toThrow();
    });

    it("grandfathering: contrato criado antes de SALE_ORDER_GATE_SINCE é isento", async () => {
      const contractId = await newContract("old", new Date("2026-01-01T00:00:00Z"));
      process.env.SALE_ORDER_GATE_SINCE = "2026-06-01T00:00:00Z";
      try { await expect(upload(contractId)).resolves.toMatchObject({ id: expect.any(Number) }); } finally { delete process.env.SALE_ORDER_GATE_SINCE; }
    });

    it("validação final recusa contrato gerado ANTES das conferências (gerado com a flag desligada, conferido depois)", async () => {
      const contractId = await newContract("late");
      delete process.env.SALE_ORDER_GATE_ENABLED;
      const admin = await (await contractsApi(adminId, "admin")).uploadDocument({ contractId, category: "Contrato", filename: "assinado.pdf", contentType: "application/pdf", base64: pdf, signed: true });
      expect(admin.id).toBeGreaterThan(0);
      await db.update(contractDocuments).set({ createdAt: new Date(Date.now() - 3_600_000) }).where((await import("drizzle-orm")).eq(contractDocuments.id, admin.id));
      await db.update(contracts).set({ signedAt: new Date(Date.now() - 1_800_000) }).where((await import("drizzle-orm")).eq(contracts.id, contractId));
      process.env.SALE_ORDER_GATE_ENABLED = "true";
      const api = await saleApi(adminId, "admin");
      await api.confirmPayment({ contractId, note: "comprovante conferido" });
      await api.confirmDocuments({ contractId, note: "documentação conferida" });
      await expect(api.validateSale({ contractId })).rejects.toThrow(/SALE_GATE_TIMESTAMP_INVALID.*ordem da formalização/);
    });
  });
});
