// ADR-007 (V6): único caminho que transforma um contrato em `active` (= venda VALIDADA) e que registra o pagamento
// confirmado. Tudo que muda estado grava, na MESMA transação: fato (sale_validations), trilha append-only
// (sale_validation_events), audit_logs e domain_events. Rejeições também deixam trilha (validation_rejected).
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { auditLogs, captureRecords, commercialProjectSettings, contractCancellationRequests, contractDocuments, contractSignatureEnvelopes, contracts, domainEvents, installments, opportunities, proposals, saleValidationEvents, saleValidations } from "../drizzle/schema";
import { canTransitionContractStatus } from "../shared/contractLifecycle";
import type { DomainEventName } from "../shared/domainEvents";
import { getDb, recordAudit } from "./db";
import { affectedRows } from "./mysqlErrors";
import { COMMISSION_BLOCKED_MESSAGE, commissionApplies, commissionBlockReason, insertInstallmentCommissions, normalizePaymentMethod, type CompleteCommissionPolicy } from "./installmentCommissions";
import { parseCompleteCommissionPolicy } from "./projectPolicy";
import { evaluateSaleValidationGates, pickSignedDocument, type SaleGateKey, type SaleValidationGates } from "./saleValidation";
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
  const documents = contract ? await reader.select({ id: contractDocuments.id, signedArtifact: contractDocuments.signedArtifact, storageKey: contractDocuments.storageKey, category: contractDocuments.category, filename: contractDocuments.filename, createdAt: contractDocuments.createdAt }).from(contractDocuments).where(eq(contractDocuments.contractId, contractId)) : [];
  const envelopes = contract ? await reader.select({ status: contractSignatureEnvelopes.status }).from(contractSignatureEnvelopes).where(eq(contractSignatureEnvelopes.contractId, contractId)) : [];
  const validation = (await reader.select().from(saleValidations).where(eq(saleValidations.contractId, contractId)).limit(1))[0] ?? null;
  const openCancellations = contract ? await reader.select({ id: contractCancellationRequests.id }).from(contractCancellationRequests).where(and(eq(contractCancellationRequests.contractId, contractId), inArray(contractCancellationRequests.status, ["requested", "approved"]))) : [];
  return { contract, documents, envelopes, validation, openCancellationRequests: openCancellations.length };
}

const gatesOf = (facts: Awaited<ReturnType<typeof loadSaleValidationFacts>>) => evaluateSaleValidationGates({ contract: facts.contract, documents: facts.documents, envelopes: facts.envelopes, validation: facts.validation, openCancellationRequests: facts.openCancellationRequests });

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
  const gates = gatesOf(facts);
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

const PRE_VALIDATION_STATUSES = ["draft", "pending_signature"];

export async function confirmPayment(actorUserId: number, input: { contractId: number; note: string; evidenceRef?: string | null }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const facts = await loadSaleValidationFacts(db, input.contractId);
  if (!facts.contract) throw saleValidationError("NOT_FOUND", "SALE_CONTRACT_NOT_FOUND", "Contrato não encontrado.");
  if (facts.validation?.paymentConfirmedAt) return { success: true as const, alreadyConfirmed: true as const, confirmedAt: facts.validation.paymentConfirmedAt };
  const stateError = (status: string) => saleValidationError("CONFLICT", "SALE_PAYMENT_CONTRACT_STATE", `Pagamento só pode ser confirmado com contrato em rascunho ou aguardando assinatura (atual: ${status}).`);
  if (!PRE_VALIDATION_STATUSES.includes(facts.contract.status)) throw stateError(facts.contract.status);
  const saleId = facts.contract.externalSaleId ?? null;
  const confirmedAt = new Date();
  const correlationId = correlationIdForContract(input.contractId);
  const outcome = await db.transaction(async tx => {
    // Mesma ordem de trava da validação final (contrato -> sale_validations): um distrato/cancelamento concorrente não passa.
    const lockedContract = (await tx.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
    if (!lockedContract) throw saleValidationError("NOT_FOUND", "SALE_CONTRACT_NOT_FOUND", "Contrato não encontrado.");
    // Garante a linha e a trava; a unique(contractId) serializa dois cliques concorrentes.
    await tx.insert(saleValidations).values({ contractId: input.contractId }).onDuplicateKeyUpdate({ set: { contractId: sql`contractId` } });
    const row = (await tx.select().from(saleValidations).where(eq(saleValidations.contractId, input.contractId)).limit(1).for("update"))[0];
    if (row?.paymentConfirmedAt) return { alreadyConfirmed: true as const, confirmedAt: row.paymentConfirmedAt };
    if (!PRE_VALIDATION_STATUSES.includes(lockedContract.status)) throw stateError(lockedContract.status);
    const update = await tx.update(saleValidations).set({ paymentConfirmedAt: confirmedAt, paymentConfirmedByUserId: actorUserId, paymentConfirmationNote: input.note, paymentEvidenceRef: input.evidenceRef ?? null }).where(eq(saleValidations.contractId, input.contractId));
    if (affectedRows(update) === 0) throw new TRPCError({ code: "CONFLICT", message: "Validação da venda alterada por outra operação. Recarregue." });
    // documentRef só referencia documento do contrato (`contract_document:<id>`); a evidência fica em sale_validations.paymentEvidenceRef.
    await tx.insert(saleValidationEvents).values({
      contractId: input.contractId, step: "payment_confirmed", actorUserId, occurredAt: confirmedAt,
      beforeJson: JSON.stringify({ paymentConfirmedAt: null }),
      afterJson: JSON.stringify({ paymentConfirmedAt: confirmedAt.toISOString(), paymentConfirmedByUserId: actorUserId }),
      reason: input.note, documentRef: null, correlationId,
    });
    await txAudit(tx, { actorUserId, entityType: "sale_validation", entityId: input.contractId, action: "payment_confirmed", summary: `Pagamento da venda do contrato ${input.contractId} confirmado pelo gerente.`, idempotencyKey: `sale-payment-confirmed:${input.contractId}` });
    await txEvent(tx, { eventName: "sale.payment.confirmed", aggregateType: "contract", aggregateId: input.contractId, actorUserId, payload: { contractId: input.contractId, saleId, confirmedAt: confirmedAt.toISOString(), confirmedByUserId: actorUserId }, idempotencyKey: `sale-payment-confirmed:${input.contractId}` });
    return { alreadyConfirmed: false as const, confirmedAt };
  });
  return { success: true as const, ...outcome };
}

/**
 * Reavalia as parcelas JÁ PAGAS do contrato recém-validado e lança as comissões que o gate bloqueou na baixa (parcela paga
 * antes da validação). Mesmo construtor e mesmo portão da baixa manual/gateway (installmentCommissions.ts); idempotente por
 * parcela+papel (reentrega nunca duplica). Política incompleta: emite o evento `commission.automatic.blocked` com o motivo.
 * Roda DENTRO da transação da validação (venda ativa + comissões nascem juntas).
 */
export async function releaseCommissionsForValidatedContract(tx: Tx, input: { contractId: number; actorUserId: number | null }) {
  const paid = await tx.select({ id: installments.id, contractId: installments.contractId, amount: installments.amount, paidAt: installments.paidAt, paymentMethod: installments.paymentMethod }).from(installments).where(and(eq(installments.contractId, input.contractId), eq(installments.status, "paid"))).orderBy(asc(installments.sequence)).for("update");
  const result = { created: 0, blocked: 0 };
  if (!paid.length) return result;
  const contract = (await tx.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
  if (!contract) return result;
  const proposal = contract.proposalId ? ((await tx.select().from(proposals).where(eq(proposals.id, contract.proposalId)).limit(1))[0] ?? null) : null;
  const opportunity = proposal?.opportunityId ? ((await tx.select().from(opportunities).where(eq(opportunities.id, proposal.opportunityId)).limit(1))[0] ?? null) : null;
  const capture = opportunity?.id ? ((await tx.select().from(captureRecords).where(eq(captureRecords.opportunityId, opportunity.id)).orderBy(desc(captureRecords.createdAt)).limit(1))[0] ?? null) : null;
  const context = { contract, proposal, opportunity, capture };
  if (!commissionApplies(context)) return result;
  const policyRow = capture?.resortId ? (await tx.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, capture.resortId)).limit(1))[0] : null;
  const policy = parseCompleteCommissionPolicy(policyRow?.commissionPolicy);
  const reason = commissionBlockReason(contract.status, policy, await isSaleValidated(tx, input.contractId));
  for (const installment of paid) {
    if (reason || !policy) {
      const why = reason ?? "incomplete_project_policy";
      await txAudit(tx, { actorUserId: input.actorUserId, entityType: "installment", entityId: installment.id, action: "commission_blocked", summary: COMMISSION_BLOCKED_MESSAGE[why], idempotencyKey: `commission-blocked:${installment.id}:${why}:sale_validation` });
      await txEvent(tx, { eventName: "commission.automatic.blocked", aggregateType: "installment", aggregateId: installment.id, actorUserId: input.actorUserId, payload: { contractId: input.contractId, reason: why, source: "sale_validation" }, idempotencyKey: `commission-blocked:${installment.id}:${why}:sale_validation` });
      result.blocked += 1;
      continue;
    }
    const facts = await insertInstallmentCommissions(tx, { installment, context, policy: policy as CompleteCommissionPolicy, paymentMethod: normalizePaymentMethod(installment.paymentMethod), compensatedAt: installment.paidAt ?? new Date() });
    for (const commission of facts) {
      await txAudit(tx, { actorUserId: input.actorUserId, entityType: "sales_commission", entityId: commission.id, action: "created", summary: `Comissão automática ${commission.commissionRole} de ${commission.amount.toFixed(2)} criada na validação da venda.`, idempotencyKey: `commission-created:${commission.id}` });
      await txEvent(tx, { eventName: "commission.created", aggregateType: "sales_commission", aggregateId: commission.id, actorUserId: input.actorUserId, payload: { sellerId: commission.sellerId, campaignId: commission.campaignId, opportunityId: commission.opportunityId, contractId: commission.contractId, sourceInstallmentId: commission.sourceInstallmentId, commissionRole: commission.commissionRole, amount: commission.amount, rate: commission.rate }, idempotencyKey: `commission-created:${commission.id}` });
      result.created += 1;
    }
  }
  return result;
}

class GatesNotReady extends Error {
  constructor(readonly reason: "gates" | "document" | "state", readonly missing: SaleGateKey[], readonly detail: string) { super(detail); }
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
      beforeJson: JSON.stringify({ contractStatus: status, gates: gates ? { paymentConfirmed: gates.paymentConfirmed, contractGenerated: gates.contractGenerated, contractSigned: gates.contractSigned, signedDocumentStored: gates.signedDocumentStored, noOpenCancellation: gates.noOpenCancellation, noOpenSignatureEnvelope: gates.noOpenSignatureEnvelope } : null }),
      afterJson: JSON.stringify({ contractStatus: status, missing }), reason, documentRef: null, correlationId,
    });
    await recordAudit(actorUserId, "sale_validation", input.contractId, "validation_rejected", `Validação final recusada para o contrato ${input.contractId}: ${reason}`);
  }

  if (!canTransitionContractStatus(pre.contract.status, "active") || pre.contract.status === "active" || pre.contract.status === "overdue") {
    const detail = `Contrato em estado ${pre.contract.status} não pode ser validado.`;
    await recordRejection(detail, [], pre.contract.status, null);
    throw saleValidationError("CONFLICT", "SALE_VALIDATION_CONTRACT_STATE", detail);
  }

  const saleId = pre.contract.externalSaleId ?? null;
  const validatedAt = new Date();
  try {
    const result = await db.transaction(async tx => {
      const locked = (await tx.select({ id: contracts.id, status: contracts.status, signedAt: contracts.signedAt }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
      if (!locked) throw new GatesNotReady("state", [], "Contrato em estado inexistente não pode ser validado.");
      const facts = await loadSaleValidationFacts(tx, input.contractId);
      // Segunda validação concorrente: quem perdeu a corrida encontra o contrato já validado => sucesso idempotente (sem rejeição).
      if (locked.status === "active" && facts.validation?.validatedAt) return { alreadyValidated: true as const, validatedAt: facts.validation.validatedAt };
      if (!PRE_VALIDATION_STATUSES.includes(locked.status)) throw new GatesNotReady("state", [], `Contrato em estado ${locked.status} não pode ser validado.`);
      const gates = gatesOf({ ...facts, contract: { ...facts.contract!, signedAt: locked.signedAt } });
      if (!gates.ready) throw new GatesNotReady("gates", gates.missing, `Portões abertos: faltam ${gates.missing.join(", ")}.`);
      const document = pickSignedDocument(facts.documents, input.signedDocumentId ?? null);
      if (!document) throw new GatesNotReady("document", [], input.signedDocumentId ? `Documento ${input.signedDocumentId} não é um documento assinado armazenado deste contrato.` : "Nenhum documento assinado armazenado.");
      const documentRow = facts.documents.find(item => item.id === document.id)!;
      // signedAt: contracts.signedAt (webhook occurred_at do e-sign) ou, sem ele, o createdAt do ARQUIVO ASSINADO (upload = horário atestado
      // do armazenamento do assinado). Nunca o createdAt do rascunho.
      const signedAt = locked.signedAt ?? documentRow.createdAt;
      const paymentConfirmedAt = facts.validation!.paymentConfirmedAt!;

      const validationUpdate = await tx.update(saleValidations).set({ validatedAt, validatedByUserId: actorUserId, signedDocumentId: document.id }).where(eq(saleValidations.contractId, input.contractId));
      if (affectedRows(validationUpdate) === 0) throw new TRPCError({ code: "CONFLICT", message: "Validação da venda alterada por outra operação. Recarregue." });
      const contractUpdate = await tx.update(contracts).set({ status: "active", activatedAt: validatedAt, signedAt, cancelledAt: undefined, cancellationReason: null }).where(and(eq(contracts.id, input.contractId), eq(contracts.status, locked.status)));
      if (affectedRows(contractUpdate) === 0) throw new TRPCError({ code: "CONFLICT", message: "O contrato foi alterado por outra operação. Recarregue e tente novamente." });
      await tx.insert(saleValidationEvents).values({
        contractId: input.contractId, step: "final_validated", actorUserId, occurredAt: validatedAt,
        beforeJson: JSON.stringify({ contractStatus: locked.status, validatedAt: null }),
        afterJson: JSON.stringify({ contractStatus: "active", validatedAt: validatedAt.toISOString(), validatedByUserId: actorUserId, signedDocumentId: document.id, paymentConfirmedAt: paymentConfirmedAt.toISOString(), signedAt: signedAt.toISOString() }),
        // Referência estável ao registro, nunca storageKey/filename (podem carregar nome/CPF do cliente).
        reason: null, documentRef: `contract_document:${document.id}`, correlationId,
      });
      await txAudit(tx, { actorUserId, entityType: "contract", entityId: input.contractId, action: "status_updated", summary: "Status alterado para active (venda validada pelo gerente)." });
      await txAudit(tx, { actorUserId, entityType: "sale_validation", entityId: input.contractId, action: "validated", summary: `Venda do contrato ${input.contractId} validada (pagamento, contrato assinado e documento armazenado conferidos).`, idempotencyKey: `sale-validated:${input.contractId}` });
      // Mesmo evento da ativação de sempre: Relationship (crm.contract.activated.v1) e Financial (status) continuam dependendo dele.
      await txEvent(tx, { eventName: "contract.status.updated", aggregateType: "contract", aggregateId: input.contractId, actorUserId, payload: { status: "active", cancellationReason: null } });
      await txEvent(tx, { eventName: "sale.validated", aggregateType: "contract", aggregateId: input.contractId, actorUserId, payload: { contractId: input.contractId, saleId, validatedAt: validatedAt.toISOString(), validatedByUserId: actorUserId, paymentConfirmedAt: paymentConfirmedAt.toISOString(), signedAt: signedAt.toISOString() }, idempotencyKey: `sale-validated:${input.contractId}` });
      // Parcelas pagas ANTES da validação (ex.: entrada) ficaram sem comissão pelo gate: reavalia agora, na mesma transação.
      await releaseCommissionsForValidatedContract(tx, { contractId: input.contractId, actorUserId });
      return { alreadyValidated: false as const, validatedAt, signedDocumentId: document.id };
    });
    if (result.alreadyValidated) return { success: true as const, alreadyValidated: true as const, validatedAt: result.validatedAt };
    try {
      await syncRevenueQualityForContract({ contractId: input.contractId, actorUserId, trigger: "validação final da venda" });
    } catch (error) {
      await recordAudit(actorUserId, "contract", input.contractId, "revenue_quality_sync_failed", "Sincronização da qualidade de receita falhou após a validação: " + (error instanceof Error ? error.message : "erro desconhecido"));
    }
    return { success: true as const, ...result };
  } catch (error) {
    const isGate = error instanceof GatesNotReady;
    const isConflict = error instanceof TRPCError && error.code === "CONFLICT";
    if (!isGate && !isConflict) throw error;
    const facts = await loadSaleValidationFacts(db, input.contractId);
    const gates = facts.contract ? gatesOf(facts) : null;
    const detail = isGate ? error.detail : (error as TRPCError).message;
    await recordRejection(detail, isGate ? error.missing : [], facts.contract?.status ?? "unknown", gates);
    if (!isGate) throw error;
    if (error.reason === "state") throw saleValidationError("CONFLICT", "SALE_VALIDATION_CONTRACT_STATE", error.detail);
    if (error.reason === "document") throw saleValidationError("PRECONDITION_FAILED", "SALE_SIGNED_DOCUMENT_INVALID", error.detail);
    throw saleValidationError("PRECONDITION_FAILED", "SALE_VALIDATION_GATES_MISSING", error.detail, { missing: error.missing });
  }
}
