import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, customerContacts, contractAddenda, contractDocuments, contracts, customers, domainEvents, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-A12 / ADR-012 em MySQL real: aditivo mínimo, desligado por padrão, sem efeito monetário. Dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("A12: aditivo contratual mínimo", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let adminId = 0;
  let customerId = 0;
  const previousEnv = { ...process.env };
  const caller = async (role: "admin" | "user" = "admin") => (await import("./routers/addenda")).addendaRouter.createCaller({ user: { id: adminId, role } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `ad-admin-${runId}`, name: "Admin Sintético", role: "admin" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `SYN Aditivo ${runId}`, email: `old.${runId}@example.test`, phone: "81900000000", status: "active" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const newContract = async (label: string, status = "active") => (await db.insert(contracts).values({ number: `AD-${label}-${runId}`, customerId, usageModel: "fixed_week", status, totalAmount: "1000.00" } as never).$returningId())[0]!.id;
  const newDoc = async (contractId: number, o: { category?: string; signed?: boolean; signedArtifact?: boolean } = {}) =>
    (await db.insert(contractDocuments).values({ contractId, category: o.category ?? "Aditivo", filename: "aditivo.pdf", storageKey: `syn/${runId}/aditivo.pdf`, signed: o.signed ?? true, signedArtifact: o.signedArtifact ?? true }).$returningId())[0]!.id;
  const customer = async () => (await db.select().from(customers).where(eq(customers.id, customerId)))[0]!;

  it("desligado por padrão: toda operação é recusada", async () => {
    delete process.env.CONTRACT_ADDENDUM_ENABLED;
    const c = await caller();
    expect((await c.enabled()).enabled).toBe(false);
    await expect(c.create({ kind: "clause", contractId: 1, reason: "motivo teste", text: "cláusula" })).rejects.toThrow(/desligado/);
    await expect(c.list({ contractId: 1 })).rejects.toThrow(/desligado/);
  });

  describe("ligado", () => {
    beforeAll(() => { process.env.CONTRACT_ADDENDUM_ENABLED = "true"; });
    afterAll(() => { delete process.env.CONTRACT_ADDENDUM_ENABLED; });

    it("ciclo de contato: rascunho e envio não mudam nada; assinado aplica, audita antes/depois e não emite evento", async () => {
      const contractId = await newContract("C1");
      const c = await caller();
      const { id } = await c.create({ kind: "contact", contractId, reason: "cliente trocou o telefone", after: { phone: "81988887777" } });
      await c.requestSignature({ id });
      expect((await customer()).phone).toBe("81900000000"); // nada muda antes da assinatura
      const docId = await newDoc(contractId);
      await c.attachSigned({ id, documentId: docId });
      expect((await customer()).phone).toBe("81988887777");
      const [row] = await db.select().from(contractAddenda).where(eq(contractAddenda.id, id));
      expect(row?.status).toBe("signed");
      expect(row?.signedDocumentId).toBe(docId);
      const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
      expect(audits.some(a => a.entityType === "contract_addendum" && a.summary.includes("81900000000"))).toBe(true);
      const own = (await db.select().from(domainEvents)).filter(e => e.aggregateType.includes("addend") || (e.aggregateType === "contract" && e.aggregateId === String(contractId)) || (e.aggregateType === "customer" && e.aggregateId === String(customerId)));
      expect(own).toHaveLength(0); // nenhum evento sai para outro sistema
      await expect(c.attachSigned({ id, documentId: docId })).rejects.toThrow(/aguardando/); // não repete efeito
    });

    it("o mesmo documento assinado não comprova dois aditivos (recusa na API e UNIQUE no banco)", async () => {
      const contractId = await newContract("C7");
      const c = await caller();
      const first = await c.create({ kind: "clause", contractId, reason: "primeiro aditivo", text: "Texto 1." });
      const second = await c.create({ kind: "clause", contractId, reason: "segundo aditivo", text: "Texto 2." });
      await c.requestSignature({ id: first.id }); await c.requestSignature({ id: second.id });
      const docId = await newDoc(contractId);
      await c.attachSigned({ id: first.id, documentId: docId });
      await expect(c.attachSigned({ id: second.id, documentId: docId })).rejects.toThrow(/já comprova/);
      expect((await db.select().from(contractAddenda).where(eq(contractAddenda.id, second.id)))[0]?.status).toBe("awaiting_signature");
      await expect(pool.query("UPDATE contract_addenda SET signedDocumentId = ? WHERE id = ?", [docId, second.id])).rejects.toThrow(/Duplicate/);
    });

    it("aditivo de contato mantém a lista de contatos coerente (preferencial por campo, na mesma transação)", async () => {
      const [own] = await db.insert(customers).values({ fullName: `SYN Contatos ${runId}`, email: `c.${runId}@example.test`, phone: "81911110000", status: "active" }).$returningId();
      const contractId = (await db.insert(contracts).values({ number: `AD-C8-${runId}`, customerId: own.id, usageModel: "fixed_week", status: "active", totalAmount: "1000.00" } as never).$returningId())[0]!.id;
      await db.insert(customerContacts).values([{ customerId: own.id, kind: "phone", value: "81911110000", isPreferred: true, createdByUserId: adminId }, { customerId: own.id, kind: "email", value: `c.${runId}@example.test`, isPreferred: true, createdByUserId: adminId }] as never);
      const c = await caller();
      const { id } = await c.create({ kind: "contact", contractId, reason: "troca de telefone e e-mail", after: { phone: "81922220000", email: `novo.${runId}@example.test` } });
      await c.requestSignature({ id });
      await c.attachSigned({ id, documentId: await newDoc(contractId) });
      const rows = await db.select().from(customerContacts).where(eq(customerContacts.customerId, own.id));
      const preferred = (kind: string) => rows.filter(r => r.kind === kind && r.isPreferred && !r.archivedAt).map(r => r.value);
      expect(preferred("phone")).toEqual(["81922220000"]);
      expect(preferred("email")).toEqual([`novo.${runId}@example.test`]);
    });

    it("documento errado não aprova: não assinado, sem arquivo assinado, outra categoria, outro contrato", async () => {
      const contractId = await newContract("C2");
      const other = await newContract("C2b");
      const c = await caller();
      const { id } = await c.create({ kind: "clause", contractId, reason: "nova cláusula acordada", text: "Fica acordado X." });
      await c.requestSignature({ id });
      for (const doc of [await newDoc(contractId, { signed: false, signedArtifact: false }), await newDoc(contractId, { signedArtifact: false }), await newDoc(contractId, { category: "Contrato" }), await newDoc(other)])
        await expect(c.attachSigned({ id, documentId: doc })).rejects.toThrow(/Vincule/);
      expect((await db.select().from(contractAddenda).where(eq(contractAddenda.id, id)))[0]?.status).toBe("awaiting_signature");
    });

    it("só administrador aprova; financeiro (não admin) é recusado", async () => {
      const contractId = await newContract("C3");
      const c = await caller();
      const { id } = await c.create({ kind: "clause", contractId, reason: "ajuste de cláusula", text: "Texto." });
      await c.requestSignature({ id });
      const docId = await newDoc(contractId);
      await expect((await caller("user")).attachSigned({ id, documentId: docId })).rejects.toThrow();
    });

    it("schema estrito: campo monetário é recusado", async () => {
      const contractId = await newContract("C4");
      const c = await caller();
      await expect(c.create({ kind: "clause", contractId, reason: "tentativa indevida", text: "Texto", totalAmount: 5 } as never)).rejects.toThrow();
      await expect(c.create({ kind: "contact", contractId, reason: "tentativa indevida", after: { phone: "81988887777", discount: 10 } } as never)).rejects.toThrow();
      await expect(c.create({ kind: "price" as never, contractId, reason: "tentativa indevida" } as never)).rejects.toThrow();
    });

    it("contrato cancelado/encerrado não aceita aditivo; cancelar rascunho funciona e não muda nada", async () => {
      const cancelled = await newContract("C5", "cancelled");
      const c = await caller();
      await expect(c.create({ kind: "clause", contractId: cancelled, reason: "motivo teste", text: "Texto." })).rejects.toThrow(/cancelado/);
      const contractId = await newContract("C6");
      const { id } = await c.create({ kind: "contact", contractId, reason: "cliente trocou o e-mail", after: { email: `new.${runId}@example.test` } });
      await c.cancel({ id });
      expect((await db.select().from(contractAddenda).where(eq(contractAddenda.id, id)))[0]?.status).toBe("cancelled");
      expect((await customer()).email).toBe(`old.${runId}@example.test`);
    });
  });
});
