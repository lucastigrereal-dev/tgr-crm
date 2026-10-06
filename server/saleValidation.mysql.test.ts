import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, contractDocuments, contracts, customers, domainEvents, saleValidationEvents, saleValidations, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { saleValidatedFactsFrom } from "./relationshipBridge";

// ADR-007 (V6) contra MySQL descartável: venda VALIDADA em uma transação, trilha append-only, rejeição auditada.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("venda validada em MySQL real (ADR-007)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let svc: typeof import("./saleValidationService");
  let adminId: number;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    svc = await import("./saleValidationService");
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 6 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `sv-admin-${runId}`, name: "Gerente SYN", role: "admin" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  async function seed(label: string, opts: { status?: "draft" | "pending_signature" | "cancelled"; signedAt?: Date | null; documents?: Array<{ signed: boolean; storageKey: string }>; saleId?: string } = {}) {
    const [customer] = await db.insert(customers).values({ fullName: `Cliente SYN ${label} ${runId}`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `SV-${label}-${runId}`, customerId: customer.id, status: opts.status ?? "pending_signature", totalAmount: "1000.00", signedAt: opts.signedAt ?? null, externalSource: opts.saleId ? "sales-command" : null, externalSaleId: opts.saleId ?? null }).$returningId();
    const documentIds: number[] = [];
    for (const [index, doc] of (opts.documents ?? []).entries()) {
      const [row] = await db.insert(contractDocuments).values({ contractId: contract.id, category: "contrato", filename: `c${index}.pdf`, storageKey: doc.storageKey, signed: doc.signed }).$returningId();
      documentIds.push(row.id);
    }
    return { contractId: contract.id, documentIds };
  }
  const eventsOf = (contractId: number, eventName: string) => db.select().from(domainEvents).where(and(eq(domainEvents.eventName, eventName as never), eq(domainEvents.aggregateId, String(contractId))));
  const trail = (contractId: number) => db.select().from(saleValidationEvents).where(eq(saleValidationEvents.contractId, contractId));
  const contractRow = async (id: number) => (await db.select().from(contracts).where(eq(contracts.id, id)))[0];

  it("confirmar pagamento é idempotente: uma linha de fato, uma trilha, um evento, um audit", async () => {
    const { contractId } = await seed("pay", { saleId: randomUUID() });
    const first = await svc.confirmPayment(adminId, { contractId, note: "Comprovante conferido", evidenceRef: "evidence/pay.png" });
    const second = await svc.confirmPayment(adminId, { contractId, note: "outra nota" });
    expect(first).toMatchObject({ success: true, alreadyConfirmed: false });
    expect(second).toMatchObject({ success: true, alreadyConfirmed: true });
    const [row] = await db.select().from(saleValidations).where(eq(saleValidations.contractId, contractId));
    expect(row).toMatchObject({ paymentConfirmedByUserId: adminId, paymentConfirmationNote: "Comprovante conferido", paymentEvidenceRef: "evidence/pay.png", validatedAt: null });
    const steps = await trail(contractId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: "payment_confirmed", actorUserId: adminId, reason: "Comprovante conferido", documentRef: "evidence/pay.png", correlationId: `crm-sale-${contractId}` });
    expect(JSON.parse(String(steps[0].beforeJson))).toEqual({ paymentConfirmedAt: null });
    const events = await eventsOf(contractId, "sale.payment.confirmed");
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0].payload))).toMatchObject({ contractId, confirmedByUserId: adminId, confirmedAt: expect.any(String) });
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "sale_validation"), eq(auditLogs.entityId, String(contractId)), eq(auditLogs.action, "payment_confirmed")))).toHaveLength(1);
    // pagamento confirmado NÃO ativa o contrato
    expect((await contractRow(contractId)).status).toBe("pending_signature");
  });

  it("confirmações simultâneas gravam um único evento", async () => {
    const { contractId } = await seed("paycc");
    await Promise.all([1, 2, 3].map(() => svc.confirmPayment(adminId, { contractId, note: "conferido" })));
    expect(await trail(contractId)).toHaveLength(1);
    expect(await eventsOf(contractId, "sale.payment.confirmed")).toHaveLength(1);
  });

  it("recusa pagamento em contrato cancelado ou inexistente", async () => {
    const { contractId } = await seed("paycx", { status: "cancelled" });
    await expect(svc.confirmPayment(adminId, { contractId, note: "conferido" })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("SALE_PAYMENT_CONTRACT_STATE") });
    await expect(svc.confirmPayment(adminId, { contractId: 999999999, note: "conferido" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await trail(contractId)).toHaveLength(0);
  });

  it("validação sem portões: recusa com lista do que falta, grava validation_rejected e não ativa", async () => {
    const { contractId } = await seed("rej");
    await expect(svc.validateSale(adminId, { contractId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("SALE_VALIDATION_GATES_MISSING"),
      cause: expect.objectContaining({ code: "SALE_VALIDATION_GATES_MISSING", missing: ["paymentConfirmed", "contractGenerated", "contractSigned", "signedDocumentStored"] }),
    });
    const steps = await trail(contractId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: "validation_rejected", actorUserId: adminId });
    expect(JSON.parse(String(steps[0].afterJson)).missing).toHaveLength(4);
    expect((await contractRow(contractId)).status).toBe("pending_signature");
    expect(await eventsOf(contractId, "sale.validated")).toHaveLength(0);
    expect(await eventsOf(contractId, "contract.status.updated")).toHaveLength(0);
    expect(await svc.isSaleValidated(db, contractId)).toBe(false);
  });

  it("assinado (webhook) mas sem pagamento confirmado: recusa só por pagamento", async () => {
    const { contractId } = await seed("nopay", { signedAt: new Date(), documents: [{ signed: true, storageKey: "contracts/x/signed.pdf" }] });
    await expect(svc.validateSale(adminId, { contractId })).rejects.toMatchObject({ cause: expect.objectContaining({ missing: ["paymentConfirmed"] }) });
    expect((await contractRow(contractId)).status).toBe("pending_signature");
  });

  it("pagamento confirmado sem assinatura/documento assinado: recusa por assinatura e armazenamento", async () => {
    const { contractId } = await seed("nosign", { documents: [{ signed: false, storageKey: "contracts/x/draft.pdf" }] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await expect(svc.validateSale(adminId, { contractId })).rejects.toMatchObject({ cause: expect.objectContaining({ missing: ["contractSigned", "signedDocumentStored"] }) });
    expect(await svc.isSaleValidated(db, contractId)).toBe(false);
  });

  it("validação final: ativa em uma transação, grava fato, trilha, eventos e é idempotente", async () => {
    const saleId = randomUUID();
    const { contractId, documentIds } = await seed("ok", { saleId, documents: [{ signed: false, storageKey: "contracts/ok/rascunho.pdf" }, { signed: true, storageKey: "contracts/ok/assinado.pdf" }] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    const result = await svc.validateSale(adminId, { contractId, signedDocumentId: documentIds[1] });
    expect(result).toMatchObject({ success: true, alreadyValidated: false, signedDocumentId: documentIds[1] });

    const contract = await contractRow(contractId);
    expect(contract.status).toBe("active");
    expect(contract.activatedAt).toBeInstanceOf(Date);
    expect(contract.signedAt).toBeInstanceOf(Date);
    const [fact] = await db.select().from(saleValidations).where(eq(saleValidations.contractId, contractId));
    expect(fact).toMatchObject({ validatedByUserId: adminId, signedDocumentId: documentIds[1] });
    expect(fact.validatedAt).toBeInstanceOf(Date);

    const steps = await trail(contractId);
    expect(steps.map(step => step.step).sort()).toEqual(["final_validated", "payment_confirmed"]);
    const final = steps.find(step => step.step === "final_validated")!;
    expect(final).toMatchObject({ actorUserId: adminId, documentRef: "contracts/ok/assinado.pdf", correlationId: `crm-sale-${contractId}` });
    expect(JSON.parse(String(final.beforeJson))).toMatchObject({ contractStatus: "pending_signature", validatedAt: null });
    expect(JSON.parse(String(final.afterJson))).toMatchObject({ contractStatus: "active", signedDocumentId: documentIds[1] });

    const statusEvents = await eventsOf(contractId, "contract.status.updated");
    expect(statusEvents).toHaveLength(1);
    expect(JSON.parse(String(statusEvents[0].payload))).toEqual({ status: "active", cancellationReason: null });
    const validated = await eventsOf(contractId, "sale.validated");
    expect(validated).toHaveLength(1);
    expect(JSON.parse(String(validated[0].payload))).toMatchObject({ contractId, saleId, validatedByUserId: adminId, validatedAt: expect.any(String), paymentConfirmedAt: expect.any(String), contractSignedAt: expect.any(String) });
    expect(JSON.stringify(validated[0].payload)).not.toContain("assinado.pdf");
    // KAN-31 V6: cada portão com instante e ator, documentRef opaco, e o payload passa nas regras do Sales.
    const payload = JSON.parse(String(validated[0].payload));
    expect(payload).toMatchObject({ validatedBy: String(adminId), paymentConfirmedBy: String(adminId), documentRef: `crm-doc:${contractId}:${documentIds[1]}` });
    expect(saleValidatedFactsFrom(payload)).not.toBeNull();
    expect(fact).toMatchObject({ documentRef: `crm-doc:${contractId}:${documentIds[1]}` });
    for (const key of ["contractGeneratedAt", "contractSignedAt", "documentStoredAt"] as const) {
      expect(fact[key]).toBeInstanceOf(Date);
      expect(fact[key]!.getTime()).toBeLessThanOrEqual(fact.validatedAt!.getTime());
      expect(payload[key]).toBe(fact[key]!.toISOString());
    }
    expect(fact.contractGeneratedAt!.getTime()).toBeLessThanOrEqual(fact.documentStoredAt!.getTime());
    // trilha e audit carregam externalSaleId
    for (const step of await trail(contractId)) expect(step.externalSaleId).toBe(saleId);
    expect(await svc.isSaleValidated(db, contractId)).toBe(true);

    expect(await svc.validateSale(adminId, { contractId })).toMatchObject({ success: true, alreadyValidated: true });
    expect(await eventsOf(contractId, "sale.validated")).toHaveLength(1);
    expect(await trail(contractId)).toHaveLength(2);
  });

  it("validações simultâneas ativam e emitem uma vez só", async () => {
    const { contractId } = await seed("okcc", { signedAt: new Date(), documents: [{ signed: true, storageKey: "contracts/cc/assinado.pdf" }] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    const results = await Promise.allSettled([1, 2, 3].map(() => svc.validateSale(adminId, { contractId })));
    expect(results.filter(r => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(await eventsOf(contractId, "sale.validated")).toHaveLength(1);
    expect(await eventsOf(contractId, "contract.status.updated")).toHaveLength(1);
    expect((await contractRow(contractId)).status).toBe("active");
  });

  it("documento indicado inválido (não assinado) recusa com código próprio e não ativa", async () => {
    const { contractId, documentIds } = await seed("baddoc", { signedAt: new Date(), documents: [{ signed: false, storageKey: "a.pdf" }, { signed: true, storageKey: "b.pdf" }] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await expect(svc.validateSale(adminId, { contractId, signedDocumentId: documentIds[0] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("SALE_SIGNED_DOCUMENT_INVALID") });
    expect((await contractRow(contractId)).status).toBe("pending_signature");
    expect((await trail(contractId)).filter(step => step.step === "validation_rejected")).toHaveLength(1);
  });

  it("contrato cancelado não valida", async () => {
    const { contractId } = await seed("canc", { status: "cancelled" });
    await expect(svc.validateSale(adminId, { contractId })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("SALE_VALIDATION_CONTRACT_STATE") });
  });

  it("trilha é append-only no banco: UPDATE e DELETE são recusados", async () => {
    const { contractId } = await seed("append");
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await expect(db.update(saleValidationEvents).set({ reason: "adulterado" }).where(eq(saleValidationEvents.contractId, contractId))).rejects.toThrow();
    await expect(db.delete(saleValidationEvents).where(eq(saleValidationEvents.contractId, contractId))).rejects.toThrow();
    expect(await trail(contractId)).toHaveLength(1);
  });
});
