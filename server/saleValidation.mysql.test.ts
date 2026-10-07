import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, commercialProjectSettings, contractCancellationRequests, contractDocuments, contracts, customers, domainEvents, installments, opportunities, proposals, resorts, saleValidationEvents, saleValidations, salesCommissions, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

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

  async function seed(label: string, opts: { status?: "draft" | "pending_signature" | "cancelled"; signedAt?: Date | null; documents?: Array<{ signed: boolean; storageKey: string; category?: string }>; saleId?: string } = {}) {
    const [customer] = await db.insert(customers).values({ fullName: `Cliente SYN ${label} ${runId}`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `SV-${label}-${runId}`, customerId: customer.id, status: opts.status ?? "pending_signature", totalAmount: "1000.00", signedAt: opts.signedAt ?? null, externalSource: opts.saleId ? "sales-command" : null, externalSaleId: opts.saleId ?? null }).$returningId();
    const documentIds: number[] = [];
    for (const [index, doc] of (opts.documents ?? []).entries()) {
      const [row] = await db.insert(contractDocuments).values({ contractId: contract.id, category: doc.category ?? "contrato", filename: `c${index}.pdf`, storageKey: doc.storageKey, signed: doc.signed, signedArtifact: doc.signed }).$returningId();
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
    expect(steps[0]).toMatchObject({ step: "payment_confirmed", actorUserId: adminId, reason: "Comprovante conferido", documentRef: null, correlationId: `crm-sale-${contractId}` });
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
    expect(final).toMatchObject({ actorUserId: adminId, documentRef: `contract_document:${documentIds[1]}`, correlationId: `crm-sale-${contractId}` });
    expect(JSON.parse(String(final.beforeJson))).toMatchObject({ contractStatus: "pending_signature", validatedAt: null });
    expect(JSON.parse(String(final.afterJson))).toMatchObject({ contractStatus: "active", signedDocumentId: documentIds[1] });

    const statusEvents = await eventsOf(contractId, "contract.status.updated");
    expect(statusEvents).toHaveLength(1);
    expect(JSON.parse(String(statusEvents[0].payload))).toEqual({ status: "active", cancellationReason: null });
    const validated = await eventsOf(contractId, "sale.validated");
    expect(validated).toHaveLength(1);
    expect(JSON.parse(String(validated[0].payload))).toMatchObject({ contractId, saleId, validatedByUserId: adminId, validatedAt: expect.any(String), paymentConfirmedAt: expect.any(String), signedAt: expect.any(String) });
    expect(JSON.stringify(validated[0].payload)).not.toContain("assinado.pdf");
    expect(await svc.isSaleValidated(db, contractId)).toBe(true);

    expect(await svc.validateSale(adminId, { contractId })).toMatchObject({ success: true, alreadyValidated: true });
    expect(await eventsOf(contractId, "sale.validated")).toHaveLength(1);
    expect(await trail(contractId)).toHaveLength(2);
  });

  it("validações simultâneas ativam e emitem uma vez só", async () => {
    const { contractId } = await seed("okcc", { signedAt: new Date(), documents: [{ signed: true, storageKey: "contracts/cc/assinado.pdf" }] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    const results = await Promise.allSettled([1, 2, 3].map(() => svc.validateSale(adminId, { contractId })));
    // Segunda/terceira chamada concorrente = sucesso idempotente (nada de CONFLICT nem linha validation_rejected).
    expect(results.map(r => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(results.filter(r => r.status === "fulfilled" && !r.value.alreadyValidated)).toHaveLength(1);
    expect((await trail(contractId)).filter(step => step.step === "validation_rejected")).toHaveLength(0);
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
  // ---------------------------------------------------------------- revisão KAN-31
  const rejections = async (contractId: number) => (await trail(contractId)).filter(step => step.step === "validation_rejected");
  async function holdContractLock<T>(contractId: number, whileHeld: () => Promise<T>, mutate: string) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("SELECT id FROM contracts WHERE id = ? FOR UPDATE", [contractId]);
      const pending = whileHeld();
      pending.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 400));
      await conn.query(mutate, [contractId]);
      await conn.commit();
      return await pending;
    } finally { conn.release(); }
  }

  it("documentos assinados de outra categoria (cópia de RG) não satisfazem os portões de assinatura", async () => {
    const { contractId } = await seed("rg", { documents: [{ signed: true, storageKey: "customers/1/rg.pdf", category: "Documento pessoal" }] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await expect(svc.validateSale(adminId, { contractId })).rejects.toMatchObject({ cause: expect.objectContaining({ code: "SALE_VALIDATION_GATES_MISSING", missing: ["contractSigned", "signedDocumentStored"] }) });
    expect((await contractRow(contractId)).status).toBe("pending_signature");
    expect(await rejections(contractId)).toHaveLength(1);
  });

  it("documento indicado de outra categoria é recusado mesmo assinado", async () => {
    const { contractId, documentIds } = await seed("rgpick", { signedAt: new Date(), documents: [{ signed: true, storageKey: "rg.pdf", category: "Comprovante" }, { signed: true, storageKey: "ok.pdf", category: "Contrato assinado" }] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await expect(svc.validateSale(adminId, { contractId, signedDocumentId: documentIds[0] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("SALE_SIGNED_DOCUMENT_INVALID") });
    await expect(svc.validateSale(adminId, { contractId, signedDocumentId: documentIds[1] })).resolves.toMatchObject({ success: true, alreadyValidated: false });
  });

  it("pedido de distrato aberto (requested|approved) fecha o portão noOpenCancellation e deixa rejeição", async () => {
    for (const status of ["requested", "approved"] as const) {
      const { contractId } = await seed(`cx-${status}`, { signedAt: new Date(), documents: [{ signed: true, storageKey: `s-${status}.pdf` }] });
      await svc.confirmPayment(adminId, { contractId, note: "conferido" });
      await db.insert(contractCancellationRequests).values({ contractId, status, reason: "cliente desistiu", simulationSnapshot: "{}", requestedByUserId: adminId });
      await expect(svc.validateSale(adminId, { contractId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", cause: expect.objectContaining({ code: "SALE_VALIDATION_GATES_MISSING", missing: ["noOpenCancellation"] }) });
      expect((await contractRow(contractId)).status).toBe("pending_signature");
      expect(await rejections(contractId)).toHaveLength(1);
      expect((await svc.getValidationStatus(contractId)).gates).toMatchObject({ noOpenCancellation: false, ready: false });
    }
  });

  it("pedido de distato rejeitado/cancelado/executado não bloqueia a validação", async () => {
    const { contractId } = await seed("cx-closed", { signedAt: new Date(), documents: [{ signed: true, storageKey: "s-closed.pdf" }] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await db.insert(contractCancellationRequests).values([{ contractId, status: "rejected", reason: "a", simulationSnapshot: "{}", requestedByUserId: adminId }, { contractId, status: "cancelled", reason: "b", simulationSnapshot: "{}", requestedByUserId: adminId }]);
    await expect(svc.validateSale(adminId, { contractId })).resolves.toMatchObject({ success: true });
  });

  it("validar/confirmar pagamento em contrato cancelado, fechado ou vencido: CONFLICT, nada gravado, rejeição de validação auditada", async () => {
    for (const status of ["cancelled", "closed", "overdue"] as const) {
      const { contractId } = await seed(`st-${status}`, { status: status as never, signedAt: new Date(), documents: [{ signed: true, storageKey: `${status}.pdf` }] });
      await expect(svc.confirmPayment(adminId, { contractId, note: "conferido" })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("SALE_PAYMENT_CONTRACT_STATE") });
      await expect(svc.validateSale(adminId, { contractId })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("SALE_VALIDATION_CONTRACT_STATE") });
      expect((await contractRow(contractId)).status).toBe(status);
      expect((await trail(contractId)).filter(step => step.step === "payment_confirmed")).toHaveLength(0);
      expect(await rejections(contractId)).toHaveLength(1);
    }
  });

  it("confirmPayment trava o contrato: cancelamento concorrente depois da pré-checagem derruba a confirmação", async () => {
    const { contractId } = await seed("paylock");
    await expect(holdContractLock(contractId, () => svc.confirmPayment(adminId, { contractId, note: "conferido" }), "UPDATE contracts SET status = 'cancelled' WHERE id = ?")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("SALE_PAYMENT_CONTRACT_STATE") });
    expect((await db.select().from(saleValidations).where(eq(saleValidations.contractId, contractId)))[0]?.paymentConfirmedAt ?? null).toBeNull();
    expect((await trail(contractId)).filter(step => step.step === "payment_confirmed")).toHaveLength(0);
  });

  it("CONFLICT dentro da transação (contrato cancelado entre a pré-checagem e a trava) também deixa validation_rejected", async () => {
    const { contractId } = await seed("vallock", { signedAt: new Date(), documents: [{ signed: true, storageKey: "vl.pdf" }] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await expect(holdContractLock(contractId, () => svc.validateSale(adminId, { contractId }), "UPDATE contracts SET status = 'cancelled' WHERE id = ?")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("SALE_VALIDATION_CONTRACT_STATE") });
    expect(await rejections(contractId)).toHaveLength(1);
    expect(await svc.isSaleValidated(db, contractId)).toBe(false);
  });

  it("PII: documentRef = contract_document:<id>; sem storageKey/filename/evidência nas trilhas e audits", async () => {
    const { contractId, documentIds } = await seed("pii", { signedAt: new Date(), documents: [{ signed: true, storageKey: "contracts/pii/Joao-Silva-CPF-123.pdf" }] });
    await svc.confirmPayment(adminId, { contractId, note: "Joao Silva pagou via PIX CPF 123", evidenceRef: "evidence/joao-silva-rg.png" });
    await svc.validateSale(adminId, { contractId });
    const steps = await trail(contractId);
    expect(steps.find(step => step.step === "final_validated")?.documentRef).toBe(`contract_document:${documentIds[0]}`);
    for (const step of steps) expect(JSON.stringify([step.documentRef, step.beforeJson, step.afterJson])).not.toMatch(/Joao-Silva|joao-silva|c0\.pdf|\.pdf|evidence\//);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "sale_validation"), eq(auditLogs.entityId, String(contractId))));
    for (const audit of audits) expect(audit.summary).not.toMatch(/Joao|CPF|\.pdf/);
  });

  // ---- comissão de parcelas pagas ANTES da validação
  const policyJson = JSON.stringify({ linerRate: 0.02, closerRate: 0.03, ftbRate: 0.04, cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt" });
  async function seedCommissionSale(label: string, opts: { policy?: string | null; paidSequences?: number[] } = {}) {
    const [liner] = await db.insert(users).values({ openId: `sv-liner-${label}-${runId}`, name: "Liner SYN", role: "seller" }).$returningId();
    const [closer] = await db.insert(users).values({ openId: `sv-closer-${label}-${runId}`, name: "Closer SYN", role: "seller" }).$returningId();
    const [resort] = await db.insert(resorts).values({ name: `Resort SYN ${label} ${runId}` } as never).$returningId();
    if (opts.policy !== null) await db.insert(commercialProjectSettings).values({ resortId: resort.id, commissionPolicy: opts.policy ?? policyJson });
    const [customer] = await db.insert(customers).values({ fullName: `Cliente COM ${label} ${runId}`, status: "active" }).$returningId();
    const [opportunity] = await db.insert(opportunities).values({ customerId: customer.id, title: `Opp ${label}`, sellerId: closer.id } as never).$returningId();
    const [proposal] = await db.insert(proposals).values({ opportunityId: opportunity.id, reference: `P-${label}-${runId}`, productDescription: "Semana fixa", totalAmount: "10000.00", downPaymentAmount: "1000.00", installmentCount: 3 }).$returningId();
    await db.insert(captureRecords).values({ customerId: customer.id, resortId: resort.id, opportunityId: opportunity.id, linerId: liner.id, closerId: closer.id } as never);
    const [contract] = await db.insert(contracts).values({ number: `COM-${label}-${runId}`, customerId: customer.id, proposalId: proposal.id, status: "pending_signature", totalAmount: "10000.00", signedAt: new Date() }).$returningId();
    await db.insert(contractDocuments).values({ contractId: contract.id, category: "Contrato assinado", filename: "c.pdf", storageKey: `contracts/com-${label}.pdf`, signed: true, signedArtifact: true });
    const installmentIds: number[] = [];
    for (const sequence of [1, 2, 3]) {
      const paid = (opts.paidSequences ?? [1]).includes(sequence);
      const [row] = await db.insert(installments).values({ contractId: contract.id, sequence, dueDate: new Date("2026-10-10T12:00:00Z"), amount: sequence === 1 ? "1000.00" : "4500.00", status: paid ? "paid" : "open", paidAmount: paid ? (sequence === 1 ? "1000.00" : "4500.00") : "0.00", paidAt: paid ? new Date("2026-10-02T12:00:00Z") : null, paymentMethod: paid ? "pix" : null }).$returningId();
      installmentIds.push(row.id);
    }
    return { contractId: contract.id, installmentIds, linerId: liner.id, closerId: closer.id };
  }
  const commissionsOf = (contractId: number) => db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contractId));

  it("entrada paga ANTES da validação: a comissão nasce na validação, na mesma transação, uma por papel", async () => {
    const { contractId, installmentIds, linerId, closerId } = await seedCommissionSale("pre");
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    expect(await commissionsOf(contractId)).toHaveLength(0);
    await svc.validateSale(adminId, { contractId });
    const rows = await commissionsOf(contractId);
    expect(rows.map(row => [row.commissionRole, row.sellerId, row.sourceInstallmentId]).sort()).toEqual([["closer", closerId, installmentIds[0]], ["liner", linerId, installmentIds[0]]].sort());
    expect(rows.every(row => row.status === "pending" && Number(row.amount) > 0)).toBe(true);
    expect(rows.find(row => row.commissionRole === "liner")!.amount).toBe("180.00");
    const created = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "commission.created"), eq(domainEvents.aggregateType, "sales_commission")));
    expect(created.filter(event => rows.some(row => String(row.id) === event.aggregateId))).toHaveLength(2);
    expect(await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "commission.automatic.blocked"), eq(domainEvents.aggregateId, String(installmentIds[0]))))).toHaveLength(0);
  });

  it("validar de novo / reentrega da reavaliação nunca duplica comissão (idempotente por parcela+papel)", async () => {
    const { contractId } = await seedCommissionSale("dup", { paidSequences: [1, 2] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await svc.validateSale(adminId, { contractId });
    const before = await commissionsOf(contractId);
    expect(before.length).toBe(4);
    await svc.validateSale(adminId, { contractId });
    await db.transaction(tx => svc.releaseCommissionsForValidatedContract(tx, { contractId, actorUserId: adminId }));
    await db.transaction(tx => svc.releaseCommissionsForValidatedContract(tx, { contractId, actorUserId: adminId }));
    expect((await commissionsOf(contractId)).map(row => row.id).sort()).toEqual(before.map(row => row.id).sort());
  });

  it("política incompleta no momento da validação: venda valida, nada de comissão, evento blocked com incomplete_project_policy", async () => {
    const { contractId, installmentIds } = await seedCommissionSale("pol", { policy: JSON.stringify({ linerRate: 0.02 }) });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await expect(svc.validateSale(adminId, { contractId })).resolves.toMatchObject({ success: true });
    expect(await commissionsOf(contractId)).toHaveLength(0);
    const blocked = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "commission.automatic.blocked"), eq(domainEvents.aggregateId, String(installmentIds[0]))));
    expect(blocked).toHaveLength(1);
    expect(JSON.parse(String(blocked[0].payload))).toMatchObject({ contractId, reason: "incomplete_project_policy", source: "sale_validation" });
    // reentrega: o mesmo bloqueio não é emitido duas vezes
    await db.transaction(tx => svc.releaseCommissionsForValidatedContract(tx, { contractId, actorUserId: adminId }));
    expect(await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "commission.automatic.blocked"), eq(domainEvents.aggregateId, String(installmentIds[0]))))).toHaveLength(1);
  });

  it("sem política cadastrada para o empreendimento também bloqueia com incomplete_project_policy", async () => {
    const { contractId, installmentIds } = await seedCommissionSale("nopol", { policy: null });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await svc.validateSale(adminId, { contractId });
    const blocked = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "commission.automatic.blocked"), eq(domainEvents.aggregateId, String(installmentIds[0]))));
    expect(JSON.parse(String(blocked[0].payload)).reason).toBe("incomplete_project_policy");
  });

  it("parcelas ainda abertas na validação não geram comissão nem bloqueio", async () => {
    const { contractId } = await seedCommissionSale("open", { paidSequences: [] });
    await svc.confirmPayment(adminId, { contractId, note: "conferido" });
    await svc.validateSale(adminId, { contractId });
    expect(await commissionsOf(contractId)).toHaveLength(0);
  });
});
