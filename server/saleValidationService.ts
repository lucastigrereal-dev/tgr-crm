// ADR-007 (V6): único caminho que transforma um contrato em `active` (= venda VALIDADA) e que registra o pagamento
// confirmado. Tudo que muda estado grava, na MESMA transação: fato (sale_validations), trilha append-only
// (sale_validation_events), audit_logs e domain_events. Rejeições também deixam trilha (validation_rejected).
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, contractDocuments, contractSignatureEnvelopes, contracts, domainEvents, saleValidationEvents, saleValidations } from "../drizzle/schema";
import { canTransitionContractStatus } from "../shared/contractLifecycle";
import type { DomainEventName } from "../shared/domainEvents";
import { getDb, recordAudit } from "./db";
import { affectedRows } from "./mysqlErrors";
import { evaluateSaleValidationGates, gatesNotAfter, pickSignedDocument, saleDocumentRef, saleGateTimestamps, type SaleGateKey, type SaleValidationGates } from "./saleValidation";
import { syncRevenueQualityForContract } from "./revenueQualitySync";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Db | Tx;

export type SaleValidationErrorCode =
  | "SALE_CONTRACT_NOT_FOUND"
  | "SALE_PAYMENT_CONTRACT_STATE"
  | "SALE_VALIDATION_CONTRACT_STATE"
  | "SALE_VALIDATION_GATES_MISSING"
  | "SALE_SIGNED_DOCUMENT_INVALID"
  | "SALE_GATE_TIMESTAMP_INVALID"
  | "SALE_VALIDATION_REQUIRED"
  | "COMMISSION_REQUIRES_VALIDATED_SALE";

/** O código de recusa vai no início da mensagem (`CODE: texto`) e em `cause.code`; tRPC não tem campo próprio. */
export function saleValidationError(trpcCode: TRPCError["code"], code: SaleValidationErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return new TRPCError({ code: trpcCode, message: `${code}: ${message}`, cause: Object.assign(new Error(code), { code, ...extra }) });
}

export const correlationIdForContract = (contractId: number) => `crm-sale-${contractId}`;

type AuditRow = typeof auditLogs.$inferInsert;
type EventRow = { eventName: DomainEventName; aggregateType: string; aggregateId: number | string; actorUserId: number | null; payload: Record<string, unknown>; idempotencyKey?: string };

async function txAudit(tx: Tx, row: Omit<AuditRow, "entityId"> & { entityId: number | string }) {
  const values = { ...row, entityId: String(row.entityId) };
  if (values.idempotencyKey) await tx.insert(auditLogs).values(values).onDuplicateKeyUpdate({ set: { idempotencyKey: sql`idempotencyKey` } });
  else await tx.insert(auditLogs).values(values);
}
async function txEvent(tx: Tx, row: EventRow) {
  const values = { eventName: row.eventName, aggregateType: row.aggregateType, aggregateId: String(row.aggregateId), actorUserId: row.actorUserId, payload: JSON.stringify(row.payload), idempotencyKey: row.idempotencyKey ?? null };
  if (values.idempotencyKey) await tx.insert(domainEvents).values(values).onDuplicateKeyUpdate({ set: { idempotencyKey: sql`idempotencyKey` } });
  else await tx.insert(domainEvents).values(values);
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

export async function loadSaleValidationFacts(reader: Reader, contractId: number) {
  const contract = (await reader.select({ id: contracts.id, status: contracts.status, signedAt: contracts.signedAt, externalSource: contracts.externalSource, externalSaleId: contracts.externalSaleId }).from(contracts).where(eq(contracts.id, contractId)).limit(1))[0] ?? null;
  const documents = contract ? await reader.select({ id: contractDocuments.id, signed: contractDocuments.signed, storageKey: contractDocuments.storageKey, filename: contractDocuments.filename, createdAt: contractDocuments.createdAt }).from(contractDocuments).where(eq(contractDocuments.contractId, contractId)) : [];
  const envelopes = contract ? await reader.select({ status: contractSignatureEnvelopes.status, createdAt: contractSignatureEnvelopes.createdAt }).from(contractSignatureEnvelopes).where(eq(contractSignatureEnvelopes.contractId, contractId)) : [];
  const validation = (await reader.select().from(saleValidations).where(eq(saleValidations.contractId, contractId)).limit(1))[0] ?? null;
  return { contract, documents, envelopes, validation };
}

/** Venda validada = fato `sale_validations.validatedAt`. Usado pelo gate de comissão. */
export async function isSaleValidated(reader: Reader, contractId: number | null | undefined): Promise<boolean> {
  if (!contractId) return false;
  const row = (await reader.select({ validatedAt: saleValidations.validatedAt }).from(saleValidations).where(eq(saleValidations.contractId, contractId)).limit(1))[0];
  return Boolean(row?.validatedAt);
}

export async function getValidationStatus(contractId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const facts = await loadSaleValidationFacts(db, contractId);
  if (!facts.contract) throw saleValidationError("NOT_FOUND", "SALE_CONTRACT_NOT_FOUND", "Contrato não encontrado.");
  const gates = evaluateSaleValidationGates({ contract: facts.contract, documents: facts.documents, envelopes: facts.envelopes, validation: facts.validation });
  const signed = pickSignedDocument(facts.documents);
  return {
    contractId,
    contractStatus: facts.contract.status,
    saleId: facts.contract.externalSaleId ?? null,
    gates,
    paymentConfirmedAt: facts.validation?.paymentConfirmedAt ?? null,
    paymentConfirmedByUserId: facts.validation?.paymentConfirmedByUserId ?? null,
    paymentConfirmationNote: facts.validation?.paymentConfirmationNote ?? null,
    validatedAt: facts.validation?.validatedAt ?? null,
    validatedByUserId: facts.validation?.validatedByUserId ?? null,
    signedDocument: signed ? { id: signed.id, filename: facts.documents.find(document => document.id === signed.id)?.filename ?? null } : null,
  };
}

export async function confirmPayment(actorUserId: number, input: { contractId: number; note: string; evidenceRef?: string | null }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const facts = await loadSaleValidationFacts(db, input.contractId);
  if (!facts.contract) throw saleValidationError("NOT_FOUND", "SALE_CONTRACT_NOT_FOUND", "Contrato não encontrado.");
  if (facts.validation?.paymentConfirmedAt) return { success: true as const, alreadyConfirmed: true as const, confirmedAt: facts.validation.paymentConfirmedAt };
  if (facts.contract.status !== "pending_signature" && facts.contract.status !== "draft") {
    throw saleValidationError("CONFLICT", "SALE_PAYMENT_CONTRACT_STATE", `Pagamento só pode ser confirmado com contrato em rascunho ou aguardando assinatura (atual: ${facts.contract.status}).`);
  }
  const saleId = facts.contract.externalSaleId ?? null;
  const confirmedAt = new Date();
  const correlationId = correlationIdForContract(input.contractId);
  const outcome = await db.transaction(async tx => {
    // Red Team P1-3: trava o contrato (mesma ordem do validateSale: contrato -> validação) e recheca o estado aqui dentro;
    // um distrato que comitou depois da pré-checagem não pode ganhar pagamento confirmado.
    const locked = (await tx.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
    if (!locked || (locked.status !== "pending_signature" && locked.status !== "draft")) {
      throw saleValidationError("CONFLICT", "SALE_PAYMENT_CONTRACT_STATE", `Pagamento só pode ser confirmado com contrato em rascunho ou aguardando assinatura (atual: ${locked?.status ?? "inexistente"}).`);
    }
    // Garante a linha e a trava; a unique(contractId) serializa dois cliques concorrentes.
    await tx.insert(saleValidations).values({ contractId: input.contractId }).onDuplicateKeyUpdate({ set: { contractId: sql`contractId` } });
    const row = (await tx.select().from(saleValidations).where(eq(saleValidations.contractId, input.contractId)).limit(1).for("update"))[0];
    if (row?.paymentConfirmedAt) return { alreadyConfirmed: true as const, confirmedAt: row.paymentConfirmedAt };
    const update = await tx.update(saleValidations).set({ paymentConfirmedAt: confirmedAt, paymentConfirmedByUserId: actorUserId, paymentConfirmationNote: input.note, paymentEvidenceRef: input.evidenceRef ?? null }).where(eq(saleValidations.contractId, input.contractId));
    if (affectedRows(update) === 0) throw new TRPCError({ code: "CONFLICT", message: "Validação da venda alterada por outra operação. Recarregue." });
    await tx.insert(saleValidationEvents).values({
      contractId: input.contractId, step: "payment_confirmed", actorUserId, occurredAt: confirmedAt,
      beforeJson: JSON.stringify({ paymentConfirmedAt: null }),
      afterJson: JSON.stringify({ paymentConfirmedAt: confirmedAt.toISOString(), paymentConfirmedByUserId: actorUserId }),
      reason: input.note, documentRef: input.evidenceRef ?? null, correlationId, externalSaleId: saleId,
    });
    await txAudit(tx, { actorUserId, entityType: "sale_validation", entityId: input.contractId, action: "payment_confirmed", summary: `Pagamento da venda do contrato ${input.contractId} confirmado pelo gerente.`, idempotencyKey: `sale-payment-confirmed:${input.contractId}` });
    await txEvent(tx, { eventName: "sale.payment.confirmed", aggregateType: "contract", aggregateId: input.contractId, actorUserId, payload: { contractId: input.contractId, saleId, confirmedAt: confirmedAt.toISOString(), confirmedByUserId: actorUserId }, idempotencyKey: `sale-payment-confirmed:${input.contractId}` });
    return { alreadyConfirmed: false as const, confirmedAt };
  });
  return { success: true as const, ...outcome };
}

class AlreadyValidated extends Error {
  constructor(readonly validatedAt: Date) { super("already validated"); }
}

class GatesNotReady extends Error {
  constructor(readonly reason: "gates" | "document" | "state" | "timestamps", readonly missing: SaleGateKey[], readonly detail: string) { super(detail); }
}

export async function validateSale(actorUserId: number, input: { contractId: number; signedDocumentId?: number | null }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const pre = await loadSaleValidationFacts(db, input.contractId);
  if (!pre.contract) throw saleValidationError("NOT_FOUND", "SALE_CONTRACT_NOT_FOUND", "Contrato não encontrado.");
  if (pre.validation?.validatedAt && pre.contract.status === "active") return { success: true as const, alreadyValidated: true as const, validatedAt: pre.validation.validatedAt };
  const correlationId = correlationIdForContract(input.contractId);

  async function recordRejection(reason: string, missing: SaleGateKey[], status: string, gates: SaleValidationGates | null) {
    const occurredAt = new Date();
    await db!.insert(saleValidationEvents).values({
      contractId: input.contractId, step: "validation_rejected", actorUserId, occurredAt,
      beforeJson: JSON.stringify({ contractStatus: status, gates: gates ? { paymentConfirmed: gates.paymentConfirmed, contractGenerated: gates.contractGenerated, contractSigned: gates.contractSigned, signedDocumentStored: gates.signedDocumentStored } : null }),
      afterJson: JSON.stringify({ contractStatus: status, missing }), reason, documentRef: null, correlationId, externalSaleId: pre.contract?.externalSaleId ?? null,
    });
    await recordAudit(actorUserId, "sale_validation", input.contractId, "validation_rejected", `Validação final recusada para o contrato ${input.contractId}: ${reason}`);
  }

  if (!canTransitionContractStatus(pre.contract.status, "active") || pre.contract.status === "active" || pre.contract.status === "overdue") {
    const detail = `Contrato em estado ${pre.contract.status} não pode ser validado.`;
    await recordRejection(detail, [], pre.contract.status, null);
    throw saleValidationError("CONFLICT", "SALE_VALIDATION_CONTRACT_STATE", detail);
  }

  const saleId = pre.contract.externalSaleId ?? null;
  // KAN-31 V6: MySQL `timestamp` guarda segundos ARREDONDADOS; um portão gravado no mesmo segundo ficaria "depois" da
  // validação e o Sales recusaria (422). Teto do segundo: todo portão já gravado (<= agora) fica <= validatedAt.
  const validatedAt = new Date(Math.ceil(Date.now() / 1000) * 1000);
  try {
    const result = await db.transaction(async tx => {
      const locked = (await tx.select({ id: contracts.id, status: contracts.status, signedAt: contracts.signedAt }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
      const facts = await loadSaleValidationFacts(tx, input.contractId);
      // Red Team P1-2: quem perdeu a corrida para outro gerente recebe "já validada", não uma recusa falsa na trilha.
      if (locked?.status === "active" && facts.validation?.validatedAt) throw new AlreadyValidated(facts.validation.validatedAt);
      if (!locked || (locked.status !== "pending_signature" && locked.status !== "draft")) throw new GatesNotReady("state", [], `Contrato em estado ${locked?.status ?? "inexistente"} não pode ser validado.`);
      const gates = evaluateSaleValidationGates({ contract: locked, documents: facts.documents, envelopes: facts.envelopes, validation: facts.validation });
      if (!gates.ready) throw new GatesNotReady("gates", gates.missing, `Portões abertos: faltam ${gates.missing.join(", ")}.`);
      const document = pickSignedDocument(facts.documents, input.signedDocumentId ?? null);
      if (!document) throw new GatesNotReady("document", [], input.signedDocumentId ? `Documento ${input.signedDocumentId} não é um documento assinado armazenado deste contrato.` : "Nenhum documento assinado armazenado.");
      const documentRow = facts.documents.find(item => item.id === document.id)!;
      const signedAt = locked.signedAt ?? documentRow.createdAt;
      const paymentConfirmedAt = facts.validation!.paymentConfirmedAt!;
      const paymentConfirmedByUserId = facts.validation!.paymentConfirmedByUserId!;
      // KAN-31 V6: instantes de cada portão congelados aqui; nenhum pode ser posterior à validação.
      const stamps = saleGateTimestamps({ documents: facts.documents, envelopes: facts.envelopes, contractSignedAt: signedAt, storedDocument: documentRow });
      if (!gatesNotAfter({ ...stamps, paymentConfirmedAt }, validatedAt)) throw new GatesNotReady("timestamps", [], "Instante de portão posterior à validação (relógio ou dado inconsistente); confira a assinatura e o documento.");
      const documentRef = saleDocumentRef(input.contractId, document.id);

      const validationUpdate = await tx.update(saleValidations).set({ validatedAt, validatedByUserId: actorUserId, signedDocumentId: document.id, ...stamps, documentRef }).where(eq(saleValidations.contractId, input.contractId));
      if (affectedRows(validationUpdate) === 0) throw new TRPCError({ code: "CONFLICT", message: "Validação da venda alterada por outra operação. Recarregue." });
      const contractUpdate = await tx.update(contracts).set({ status: "active", activatedAt: validatedAt, signedAt, cancelledAt: undefined, cancellationReason: null }).where(and(eq(contracts.id, input.contractId), eq(contracts.status, locked.status)));
      if (affectedRows(contractUpdate) === 0) throw new TRPCError({ code: "CONFLICT", message: "O contrato foi alterado por outra operação. Recarregue e tente novamente." });
      await tx.insert(saleValidationEvents).values({
        contractId: input.contractId, step: "final_validated", actorUserId, occurredAt: validatedAt,
        beforeJson: JSON.stringify({ contractStatus: locked.status, validatedAt: null }),
        afterJson: JSON.stringify({ contractStatus: "active", validatedAt: validatedAt.toISOString(), validatedByUserId: actorUserId, signedDocumentId: document.id, paymentConfirmedAt: paymentConfirmedAt.toISOString(), paymentConfirmedByUserId, contractGeneratedAt: stamps.contractGeneratedAt.toISOString(), contractSignedAt: stamps.contractSignedAt.toISOString(), documentStoredAt: stamps.documentStoredAt.toISOString(), documentRef }),
        // Trilha append-only: só a referência opaca (o storageKey carrega nome de arquivo, que pode ter dado do cliente).
        reason: null, documentRef, correlationId, externalSaleId: saleId,
      });
      await txAudit(tx, { actorUserId, entityType: "contract", entityId: input.contractId, action: "status_updated", summary: "Status alterado para active (venda validada pelo gerente)." });
      await txAudit(tx, { actorUserId, entityType: "sale_validation", entityId: input.contractId, action: "validated", summary: `Venda do contrato ${input.contractId} validada (pagamento, contrato assinado e documento armazenado conferidos).`, idempotencyKey: `sale-validated:${input.contractId}` });
      // Mesmo evento da ativação de sempre: Relationship (crm.contract.activated.v1) e Financial (status) continuam dependendo dele.
      await txEvent(tx, { eventName: "contract.status.updated", aggregateType: "contract", aggregateId: input.contractId, actorUserId, payload: { status: "active", cancellationReason: null } });
      await txEvent(tx, { eventName: "sale.validated", aggregateType: "contract", aggregateId: input.contractId, actorUserId, payload: {
        contractId: input.contractId, saleId,
        validatedAt: validatedAt.toISOString(), validatedByUserId: actorUserId, validatedBy: String(actorUserId),
        paymentConfirmedAt: paymentConfirmedAt.toISOString(), paymentConfirmedByUserId, paymentConfirmedBy: String(paymentConfirmedByUserId),
        contractGeneratedAt: stamps.contractGeneratedAt.toISOString(), contractSignedAt: stamps.contractSignedAt.toISOString(),
        documentStoredAt: stamps.documentStoredAt.toISOString(), documentRef,
      }, idempotencyKey: `sale-validated:${input.contractId}` });
      return { validatedAt, signedDocumentId: document.id };
    });
    try {
      await syncRevenueQualityForContract({ contractId: input.contractId, actorUserId, trigger: "validação final da venda" });
    } catch (error) {
      await recordAudit(actorUserId, "contract", input.contractId, "revenue_quality_sync_failed", "Sincronização da qualidade de receita falhou após a validação: " + (error instanceof Error ? error.message : "erro desconhecido"));
    }
    return { success: true as const, alreadyValidated: false as const, ...result };
  } catch (error) {
    if (error instanceof AlreadyValidated) return { success: true as const, alreadyValidated: true as const, validatedAt: error.validatedAt };
    if (!(error instanceof GatesNotReady)) throw error;
    const facts = await loadSaleValidationFacts(db, input.contractId);
    const gates = facts.contract ? evaluateSaleValidationGates({ contract: facts.contract, documents: facts.documents, envelopes: facts.envelopes, validation: facts.validation }) : null;
    await recordRejection(error.detail, error.missing, facts.contract?.status ?? "unknown", gates);
    if (error.reason === "state") throw saleValidationError("CONFLICT", "SALE_VALIDATION_CONTRACT_STATE", error.detail);
    if (error.reason === "timestamps") throw saleValidationError("PRECONDITION_FAILED", "SALE_GATE_TIMESTAMP_INVALID", error.detail);
    if (error.reason === "document") throw saleValidationError("PRECONDITION_FAILED", "SALE_SIGNED_DOCUMENT_INVALID", error.detail);
    throw saleValidationError("PRECONDITION_FAILED", "SALE_VALIDATION_GATES_MISSING", error.detail, { missing: error.missing });
  }
}
