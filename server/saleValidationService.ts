// ADR-007 (V6): único caminho que transforma um contrato em `active` (= venda VALIDADA) e que registra o pagamento
// confirmado. Tudo que muda estado grava, na MESMA transação: fato (sale_validations), trilha append-only
// (sale_validation_events), audit_logs e domain_events. Rejeições também deixam trilha (validation_rejected).
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { captureRecords, commercialFractions, commercialProjectSettings, contractCancellationRequests, contractDocuments, contractSignatureEnvelopes, contracts, domainEvents, installments, opportunities, proposals, saleValidationEvents, saleValidations, salesCommissions } from "../drizzle/schema";
import { canTransitionContractStatus } from "../shared/contractLifecycle";
import { getDb, recordAudit } from "./db";
import { affectedRows, withDeadlockRetry } from "./mysqlErrors";
import { COMMISSION_BLOCKED_MESSAGE, COMMISSION_SKIPPED_MESSAGE, COMMISSION_SKIPPED_REASON, commissionApplies, commissionBlockReason, insertInstallmentCommissions, normalizePaymentMethod, zeroRateSkippedRoles, type CompleteCommissionPolicy } from "./installmentCommissions";
import { parseCompleteCommissionPolicy } from "./projectPolicy";
import { evaluateSaleValidationGates, gatesNotAfter, isContractDocumentCategory, pickSignedDocument, saleDocumentRef, saleGateTimestamps, type SaleGateKey, type SaleValidationGates } from "./saleValidation";
import { createHash } from "node:crypto";
import { conferralsBeforeGeneration, saleOrderGateState } from "./saleOrderGate";
import { isInventoryHoldAtFormalizationEnabled, settleFormalizationInventory } from "./formalizationInventory";
import { commissionPolicyAnchor, isCommissionPolicyVersioningEnabled, resolveCommissionPolicy } from "./commissionPolicyVersion";
import { isSegregationEnabled } from "./saleValidatorAccess";
import { syncRevenueQualityForContract } from "./revenueQualitySync";
import { txAudit, txEvent, type Tx } from "./txOutbox";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Reader = Db | Tx;

export type SaleValidationErrorCode =
  | "SALE_CONTRACT_NOT_FOUND"
  | "SALE_PAYMENT_CONTRACT_STATE"
  | "SALE_VALIDATION_CONTRACT_STATE"
  | "SALE_VALIDATION_GATES_MISSING"
  | "SALE_SIGNED_DOCUMENT_INVALID"
  | "SALE_GATE_TIMESTAMP_INVALID"
  | "SALE_VALIDATION_REQUIRED"
  | "SALE_SEGREGATION"
  | "INVENTORY_HELD_EXPIRED"
  | "COMMISSION_REQUIRES_VALIDATED_SALE";

/** O código de recusa vai no início da mensagem (`CODE: texto`) e em `cause.code`; tRPC não tem campo próprio. */
export function saleValidationError(trpcCode: TRPCError["code"], code: SaleValidationErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return new TRPCError({ code: trpcCode, message: `${code}: ${message}`, cause: Object.assign(new Error(code), { code, ...extra }) });
}

/** Atestado gravado na trilha da validação final (CRM-C1): quem validou declara ter conferido o conjunto cujo hash segue. */
export const SALE_VALIDATION_ATTESTATION = "Declaro ter conferido o comprovante, a documentação e o documento assinado desta venda.";
/** SHA-256 do conjunto conferido (referência opaca do documento, referência do comprovante e nota de conferência). */
export const saleEvidenceHash = (parts: { documentRef: string; paymentEvidenceRef: string | null; paymentConfirmationNote: string | null }) => createHash("sha256").update(JSON.stringify([parts.documentRef, parts.paymentEvidenceRef, parts.paymentConfirmationNote])).digest("hex");

export const correlationIdForContract = (contractId: number) => `crm-sale-${contractId}`;


const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

export async function loadSaleValidationFacts(reader: Reader, contractId: number) {
  const contract = (await reader.select({ id: contracts.id, status: contracts.status, signedAt: contracts.signedAt, externalSource: contracts.externalSource, externalSaleId: contracts.externalSaleId, inventoryLostAt: contracts.inventoryLostAt }).from(contracts).where(eq(contracts.id, contractId)).limit(1))[0] ?? null;
  const documents = contract ? await reader.select({ id: contractDocuments.id, signedArtifact: contractDocuments.signedArtifact, storageKey: contractDocuments.storageKey, category: contractDocuments.category, filename: contractDocuments.filename, createdAt: contractDocuments.createdAt }).from(contractDocuments).where(eq(contractDocuments.contractId, contractId)) : [];
  const envelopes = contract ? await reader.select({ status: contractSignatureEnvelopes.status, createdAt: contractSignatureEnvelopes.createdAt }).from(contractSignatureEnvelopes).where(eq(contractSignatureEnvelopes.contractId, contractId)) : [];
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
    documentsConferredAt: facts.validation?.documentsConferredAt ?? null,
    documentsConferredByUserId: facts.validation?.documentsConferredByUserId ?? null,
    documentsConferredNote: facts.validation?.documentsConferredNote ?? null,
    orderGate: await saleOrderGateState(db, contractId),
    validatedAt: facts.validation?.validatedAt ?? null,
    validatedByUserId: facts.validation?.validatedByUserId ?? null,
    signedDocument: signed ? { id: signed.id, filename: facts.documents.find(document => document.id === signed.id)?.filename ?? null } : null,
  };
}

/** Conferência gravada, mas a reserva da cota venceu antes: a cota voltou ao estoque (já commitado); o administrativo precisa saber. */
function throwIfInventoryLost(outcome: { settle?: { status: string } }) {
  if (outcome.settle?.status === "lost") throw saleValidationError("CONFLICT", "INVENTORY_HELD_EXPIRED", "A reserva da cota venceu antes da conferência; a cota voltou ao estoque. Refazer a venda.");
}

/** Reserva perdida é fato persistido: retry/idempotência devolvem o mesmo erro, nunca sucesso. */
function throwIfContractInventoryLost(contract: { inventoryLostAt?: Date | null } | null) {
  if (contract?.inventoryLostAt) throw saleValidationError("CONFLICT", "INVENTORY_HELD_EXPIRED", "A reserva da cota venceu antes da conferência; a cota voltou ao estoque. Refazer a venda.");
}

const PRE_VALIDATION_STATUSES = ["draft", "pending_signature"];

export async function confirmPayment(actorUserId: number, input: { contractId: number; note: string; evidenceRef?: string | null }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const facts = await loadSaleValidationFacts(db, input.contractId);
  if (!facts.contract) throw saleValidationError("NOT_FOUND", "SALE_CONTRACT_NOT_FOUND", "Contrato não encontrado.");
  throwIfContractInventoryLost(facts.contract);
  if (facts.validation?.paymentConfirmedAt) return { success: true as const, alreadyConfirmed: true as const, confirmedAt: facts.validation.paymentConfirmedAt };
  const stateError = (status: string) => saleValidationError("CONFLICT", "SALE_PAYMENT_CONTRACT_STATE", `Pagamento só pode ser confirmado com contrato em rascunho ou aguardando assinatura (atual: ${status}).`);
  if (!PRE_VALIDATION_STATUSES.includes(facts.contract.status)) throw stateError(facts.contract.status);
  const saleId = facts.contract.externalSaleId ?? null;
  const confirmedAt = new Date();
  const correlationId = correlationIdForContract(input.contractId);
  const outcome = await withDeadlockRetry(() => db.transaction(async tx => {
    // Mesma ordem de trava da validação final (contrato -> sale_validations): um distrato/cancelamento concorrente não passa.
    const lockedContract = (await tx.select({ status: contracts.status, inventoryLostAt: contracts.inventoryLostAt }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
    if (!lockedContract) throw saleValidationError("NOT_FOUND", "SALE_CONTRACT_NOT_FOUND", "Contrato não encontrado.");
    throwIfContractInventoryLost(lockedContract);
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
      reason: input.note, documentRef: null, correlationId, externalSaleId: saleId,
    });
    await txAudit(tx, { actorUserId, entityType: "sale_validation", entityId: input.contractId, action: "payment_confirmed", summary: `Pagamento da venda do contrato ${input.contractId} conferido pelo administrativo autorizado.`, idempotencyKey: `sale-payment-confirmed:${input.contractId}` });
    await txEvent(tx, { eventName: "sale.payment.confirmed", aggregateType: "contract", aggregateId: input.contractId, actorUserId, payload: { contractId: input.contractId, saleId, confirmedAt: confirmedAt.toISOString(), confirmedByUserId: actorUserId }, idempotencyKey: `sale-payment-confirmed:${input.contractId}` });
    const settle = await settleFormalizationInventory(tx, input.contractId, actorUserId, confirmedAt);
    return { alreadyConfirmed: false as const, confirmedAt, settle };
  }));
  throwIfInventoryLost(outcome);
  return { success: true as const, alreadyConfirmed: outcome.alreadyConfirmed, confirmedAt: outcome.confirmedAt };
}

async function loadCommissionContext(tx: Reader, contractId: number) {
  const contract = (await tx.select().from(contracts).where(eq(contracts.id, contractId)).limit(1))[0];
  if (!contract) return null;
  const proposal = contract.proposalId ? ((await tx.select().from(proposals).where(eq(proposals.id, contract.proposalId)).limit(1))[0] ?? null) : null;
  const opportunity = proposal?.opportunityId ? ((await tx.select().from(opportunities).where(eq(opportunities.id, proposal.opportunityId)).limit(1))[0] ?? null) : null;
  const capture = opportunity?.id ? ((await tx.select().from(captureRecords).where(eq(captureRecords.opportunityId, opportunity.id)).orderBy(desc(captureRecords.createdAt)).limit(1))[0] ?? null) : null;
  const context = { contract, proposal, opportunity, capture };
  // D2=B: a versão da política é a da data do VENDEU (fato original), igual para todas as parcelas do contrato.
  const resolved = await resolveCommissionPolicy(tx, capture?.resortId, commissionPolicyAnchor(capture, contract));
  return { context, policy: resolved.policy, resortId: capture?.resortId ?? null };
}

/** ADR-010: registro rastreável (auditoria + evento interno) de parcela paga sem lançamento porque todos os papéis estão a 0%. Idempotente por parcela. */
export async function recordZeroRateSkip(tx: Tx, input: { installmentId: number; contractId: number; resortId: number | null; roles: string[]; actorUserId: number | null; source: string }) {
  const key = `commission-skipped:${input.installmentId}:${COMMISSION_SKIPPED_REASON}`;
  await txAudit(tx, { actorUserId: input.actorUserId, entityType: "installment", entityId: input.installmentId, action: "commission_skipped", summary: COMMISSION_SKIPPED_MESSAGE, idempotencyKey: key });
  await txEvent(tx, { eventName: "commission.automatic.skipped", aggregateType: "installment", aggregateId: input.installmentId, actorUserId: input.actorUserId, payload: { contractId: input.contractId, installmentId: input.installmentId, resortId: input.resortId, reason: COMMISSION_SKIPPED_REASON, roles: input.roles, source: input.source }, idempotencyKey: key });
}

async function recordCreatedCommissions(tx: Tx, facts: Awaited<ReturnType<typeof insertInstallmentCommissions>>, actorUserId: number | null, summarySuffix: string) {
  for (const commission of facts) {
    await txAudit(tx, { actorUserId, entityType: "sales_commission", entityId: commission.id, action: "created", summary: `Comissão automática ${commission.commissionRole} de ${commission.amount.toFixed(2)} criada ${summarySuffix}.`, idempotencyKey: `commission-created:${commission.id}` });
    await txEvent(tx, { eventName: "commission.created", aggregateType: "sales_commission", aggregateId: commission.id, actorUserId, payload: { sellerId: commission.sellerId, campaignId: commission.campaignId, opportunityId: commission.opportunityId, contractId: commission.contractId, sourceInstallmentId: commission.sourceInstallmentId, commissionRole: commission.commissionRole, amount: commission.amount, rate: commission.rate, ...(commission.policyVersion ? { policyVersion: commission.policyVersion } : {}) }, idempotencyKey: `commission-created:${commission.id}` });
  }
}

/**
 * Reavalia as parcelas JÁ PAGAS do contrato recém-validado e lança as comissões que o gate bloqueou na baixa (parcela paga
 * antes da validação). Mesmo construtor e mesmo portão da baixa manual/gateway (installmentCommissions.ts); idempotente por
 * parcela+papel (reentrega nunca duplica). Política incompleta: emite o evento `commission.automatic.blocked` com o motivo.
 * Portão aberto mas todos os papéis a 0%: emite `commission.automatic.skipped` (zero_rate) para reprocesso futuro.
 * Roda DENTRO da transação da validação (venda ativa + comissões nascem juntas).
 */
export async function releaseCommissionsForValidatedContract(tx: Tx, input: { contractId: number; actorUserId: number | null }) {
  const paid = await tx.select({ id: installments.id, contractId: installments.contractId, amount: installments.amount, paidAt: installments.paidAt, paymentMethod: installments.paymentMethod }).from(installments).where(and(eq(installments.contractId, input.contractId), eq(installments.status, "paid"))).orderBy(asc(installments.sequence)).for("update");
  const result = { created: 0, blocked: 0, skipped: 0 };
  if (!paid.length) return result;
  const loaded = await loadCommissionContext(tx, input.contractId);
  if (!loaded) return result;
  const { context, resortId } = loaded;
  if (!commissionApplies(context)) return result;
  const validated = await isSaleValidated(tx, input.contractId);
  const versioned = isCommissionPolicyVersioningEnabled();
  for (const installment of paid) {
    // D2=B: a política é a da data do VENDEU (resolvida uma vez em loadCommissionContext), não a da data de cada parcela paga.
    const policy = loaded.policy;
    const reason = commissionBlockReason(context.contract.status, policy, validated);
    if (reason || !policy) {
      const why = reason ?? "incomplete_project_policy";
      await txAudit(tx, { actorUserId: input.actorUserId, entityType: "installment", entityId: installment.id, action: "commission_blocked", summary: COMMISSION_BLOCKED_MESSAGE[why], idempotencyKey: `commission-blocked:${installment.id}:${why}:sale_validation` });
      await txEvent(tx, { eventName: "commission.automatic.blocked", aggregateType: "installment", aggregateId: installment.id, actorUserId: input.actorUserId, payload: { contractId: input.contractId, reason: why, source: "sale_validation" }, idempotencyKey: `commission-blocked:${installment.id}:${why}:sale_validation` });
      result.blocked += 1;
      continue;
    }
    const zeroRoles = zeroRateSkippedRoles(context.capture, policy);
    if (zeroRoles) {
      await recordZeroRateSkip(tx, { installmentId: installment.id, contractId: input.contractId, resortId, roles: zeroRoles, actorUserId: input.actorUserId, source: "sale_validation" });
      result.skipped += 1;
      continue;
    }
    const facts = await insertInstallmentCommissions(tx, { installment, context, policy: policy as CompleteCommissionPolicy, paymentMethod: normalizePaymentMethod(installment.paymentMethod), compensatedAt: installment.paidAt ?? new Date(), paidAsOf: installment.paidAt });
    await recordCreatedCommissions(tx, facts, input.actorUserId, "na validação da venda");
    result.created += facts.length;
  }
  return result;
}

const SKIPPED_SCAN_LIMIT = 5000;
const SKIPPED_SCAN_MAX_PAGES = 200;

/**
 * ADR-010: reprocessa parcelas pagas durante a janela de 0% (têm registro `commission.automatic.skipped` e NENHUMA linha
 * de comissão) depois que as taxas por papel mudaram. Só em contrato ATIVO com venda VALIDADA e política completa (mesmo portão
 * da baixa); lê taxa/política atuais; idempotente (parcela que já ganhou comissão sai do conjunto; reexecução é no-op);
 * cada lançamento é auditado + `commission.created`; parcela que continua a 0% permanece pendente de reprocesso.
 */
export async function reprocessSkippedCommissions(db: Db, input: { contractId?: number; resortId?: number; actorUserId: number }) {
  // Issue #38 (3): varre TODOS os `skipped` em páginas por cursor de id (antes: só os 5000 mais recentes, perdendo parcelas antigas).
  // Teto de segurança em páginas; só marca `truncated` se estourar o teto.
  const events: { aggregateId: string; payload: string | null }[] = [];
  let cursor: number | null = null; let truncated = false;
  for (let page = 0; ; page += 1) {
    if (page >= SKIPPED_SCAN_MAX_PAGES) { truncated = true; break; }
    const rows: { id: number; aggregateId: string; payload: string | null }[] = await db.select({ id: domainEvents.id, aggregateId: domainEvents.aggregateId, payload: domainEvents.payload }).from(domainEvents)
      .where(cursor === null ? eq(domainEvents.eventName, "commission.automatic.skipped") : and(eq(domainEvents.eventName, "commission.automatic.skipped"), lt(domainEvents.id, cursor)))
      .orderBy(desc(domainEvents.id)).limit(SKIPPED_SCAN_LIMIT);
    events.push(...rows);
    if (rows.length < SKIPPED_SCAN_LIMIT) break;
    cursor = rows[rows.length - 1]!.id;
  }
  const byContract = new Map<number, Set<number>>();
  for (const event of events) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(event.payload ?? "{}") as Record<string, unknown>; } catch { continue; }
    const contractId = Number(payload.contractId); const installmentId = Number(event.aggregateId);
    if (!Number.isInteger(contractId) || !Number.isInteger(installmentId)) continue;
    if (input.contractId !== undefined && contractId !== input.contractId) continue;
    if (input.resortId !== undefined && Number(payload.resortId) !== input.resortId) continue;
    const set = byContract.get(contractId) ?? new Set<number>(); set.add(installmentId); byContract.set(contractId, set);
  }
  const summary = { candidates: 0, created: 0, stillZeroRate: 0, ineligible: 0, alreadyCommissioned: 0, truncated, createdInstallmentIds: [] as number[] };
  for (const [contractId, installmentIds] of Array.from(byContract.entries()).sort((a, b) => a[0] - b[0])) {
    await db.transaction(async tx => {
      const locked = (await tx.select({ id: contracts.id, status: contracts.status }).from(contracts).where(eq(contracts.id, contractId)).limit(1).for("update"))[0];
      const paid = locked ? await tx.select({ id: installments.id, contractId: installments.contractId, amount: installments.amount, paidAt: installments.paidAt, paymentMethod: installments.paymentMethod }).from(installments).where(and(eq(installments.contractId, contractId), eq(installments.status, "paid"), inArray(installments.id, Array.from(installmentIds)))).orderBy(asc(installments.sequence)).for("update") : [];
      summary.candidates += installmentIds.size;
      const loaded = locked && paid.length ? await loadCommissionContext(tx, contractId) : null;
      const versioned = isCommissionPolicyVersioningEnabled();
      const validated = loaded ? await isSaleValidated(tx, contractId) : false;
      // Sem versionamento a política é uma só (a atual): o portão decide antes do loop. Com versionamento, cada parcela tem a política da SUA data (portão e taxa dentro do loop).
      const gateOpen = loaded && commissionApplies(loaded.context) && (versioned || (loaded.policy && commissionBlockReason(locked!.status, loaded.policy, validated) === null));
      if (!loaded || !gateOpen) { summary.ineligible += installmentIds.size; return; }
      summary.ineligible += installmentIds.size - paid.length;
      for (const installment of paid) {
        const existing = await tx.select({ id: salesCommissions.id }).from(salesCommissions).where(eq(salesCommissions.sourceInstallmentId, installment.id)).limit(1);
        if (existing.length) { summary.alreadyCommissioned += 1; continue; }
        // D2=B: a vigência é a da data do VENDEU (política do fato original), não a da parcela nem a de hoje.
        const effective = loaded.policy;
        if (!effective || (versioned && commissionBlockReason(locked!.status, effective, validated) !== null)) { summary.ineligible += 1; continue; }
        if (zeroRateSkippedRoles(loaded.context.capture, effective)) { summary.stillZeroRate += 1; continue; }
        const facts = await insertInstallmentCommissions(tx, { installment, context: { ...loaded.context, contract: { ...loaded.context.contract, status: locked!.status } }, policy: effective as CompleteCommissionPolicy, paymentMethod: normalizePaymentMethod(installment.paymentMethod), compensatedAt: installment.paidAt ?? new Date(), paidAsOf: installment.paidAt });
        if (!facts.length) { summary.stillZeroRate += 1; continue; }
        await recordCreatedCommissions(tx, facts, input.actorUserId, "pelo reprocessamento da janela de 0%");
        await txAudit(tx, { actorUserId: input.actorUserId, entityType: "installment", entityId: installment.id, action: "commission_skipped_reprocessed", summary: `Parcela paga na janela de 0% reprocessada: ${facts.length} comissão(ões) criada(s) ${versioned ? "com a política vigente na data do pagamento da parcela" : "com as taxas atuais"}.`, idempotencyKey: `commission-skipped-reprocessed:${installment.id}` });
        summary.created += facts.length; summary.createdInstallmentIds.push(installment.id);
      }
    });
  }
  return summary;
}

export async function confirmDocuments(actorUserId: number, input: { contractId: number; note: string }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const facts = await loadSaleValidationFacts(db, input.contractId);
  if (!facts.contract) throw saleValidationError("NOT_FOUND", "SALE_CONTRACT_NOT_FOUND", "Contrato não encontrado.");
  throwIfContractInventoryLost(facts.contract);
  if (facts.validation?.documentsConferredAt) return { success: true as const, alreadyConfirmed: true as const, confirmedAt: facts.validation.documentsConferredAt };
  const stateError = (status: string) => saleValidationError("CONFLICT", "SALE_PAYMENT_CONTRACT_STATE", `Documentação só pode ser conferida com contrato em rascunho ou aguardando assinatura (atual: ${status}).`);
  if (!PRE_VALIDATION_STATUSES.includes(facts.contract.status)) throw stateError(facts.contract.status);
  const confirmedAt = new Date();
  const outcome = await withDeadlockRetry(() => db.transaction(async tx => {
    const lockedContract = (await tx.select({ status: contracts.status, inventoryLostAt: contracts.inventoryLostAt }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
    if (!lockedContract) throw saleValidationError("NOT_FOUND", "SALE_CONTRACT_NOT_FOUND", "Contrato não encontrado.");
    throwIfContractInventoryLost(lockedContract);
    await tx.insert(saleValidations).values({ contractId: input.contractId }).onDuplicateKeyUpdate({ set: { contractId: sql`contractId` } });
    const row = (await tx.select().from(saleValidations).where(eq(saleValidations.contractId, input.contractId)).limit(1).for("update"))[0];
    if (row?.documentsConferredAt) return { alreadyConfirmed: true as const, confirmedAt: row.documentsConferredAt };
    if (!PRE_VALIDATION_STATUSES.includes(lockedContract.status)) throw stateError(lockedContract.status);
    const update = await tx.update(saleValidations).set({ documentsConferredAt: confirmedAt, documentsConferredByUserId: actorUserId, documentsConferredNote: input.note }).where(eq(saleValidations.contractId, input.contractId));
    if (affectedRows(update) === 0) throw new TRPCError({ code: "CONFLICT", message: "Validação da venda alterada por outra operação. Recarregue." });
    // Fato interno do CRM: sem evento para outro sistema (nenhum contrato muda). A trilha é a auditoria com ator e nota.
    await txAudit(tx, { actorUserId, entityType: "sale_validation", entityId: input.contractId, action: "documents_conferred", summary: `Documentação do contrato ${input.contractId} conferida pelo administrativo autorizado: ${input.note}`, idempotencyKey: `sale-documents-confer:${input.contractId}` });
    const settle = await settleFormalizationInventory(tx, input.contractId, actorUserId, confirmedAt);
    return { alreadyConfirmed: false as const, confirmedAt, settle };
  }));
  throwIfInventoryLost(outcome);
  return { success: true as const, alreadyConfirmed: outcome.alreadyConfirmed, confirmedAt: outcome.confirmedAt };
}

class GatesNotReady extends Error {
  constructor(readonly reason: "gates" | "document" | "state" | "timestamps" | "inventory", readonly missing: SaleGateKey[], readonly detail: string) { super(detail); }
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
      if (!locked) throw new GatesNotReady("state", [], "Contrato em estado inexistente não pode ser validado.");
      const facts = await loadSaleValidationFacts(tx, input.contractId);
      // Segunda validação concorrente: quem perdeu a corrida encontra o contrato já validado => sucesso idempotente (sem rejeição).
      if (locked.status === "active" && facts.validation?.validatedAt) return { alreadyValidated: true as const, validatedAt: facts.validation.validatedAt };
      if (!PRE_VALIDATION_STATUSES.includes(locked.status)) throw new GatesNotReady("state", [], `Contrato em estado ${locked.status} não pode ser validado.`);
      {
        const stock = (await tx.select({ lost: contracts.inventoryLostAt }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
        const held = await tx.select({ id: commercialFractions.id }).from(commercialFractions).where(and(eq(commercialFractions.currentContractId, input.contractId), eq(commercialFractions.status, "held"))).limit(1);
        if (stock?.lost || held.length) throw new GatesNotReady("inventory", [], "A cota deste contrato não está vendida (reserva vencida ou conferências pendentes).");
      }
      const gates = gatesOf({ ...facts, contract: { ...facts.contract!, signedAt: locked.signedAt } });
      if (!gates.ready) throw new GatesNotReady("gates", gates.missing, `Portões abertos: faltam ${gates.missing.join(", ")}.`);
      const document = pickSignedDocument(facts.documents, input.signedDocumentId ?? null);
      if (!document) throw new GatesNotReady("document", [], input.signedDocumentId ? `Documento ${input.signedDocumentId} não é um documento assinado armazenado deste contrato.` : "Nenhum documento assinado armazenado.");
      const documentRow = facts.documents.find(item => item.id === document.id)!;
      // signedAt: contracts.signedAt (webhook occurred_at do e-sign) ou, sem ele, o createdAt do ARQUIVO ASSINADO (upload = horário atestado
      // do armazenamento do assinado). Nunca o createdAt do rascunho.
      const signedAt = locked.signedAt ?? documentRow.createdAt;
      const paymentConfirmedAt = facts.validation!.paymentConfirmedAt!;
      const paymentConfirmedByUserId = facts.validation!.paymentConfirmedByUserId!;
      // CRM-C1: segregação opcional (padrão desligada). A mesma pessoa PODE conferir e validar; a trilha registra quem fez cada ato.
      if (paymentConfirmedByUserId === actorUserId && await isSegregationEnabled(tx)) throw saleValidationError("FORBIDDEN", "SALE_SEGREGATION", "A segregação de funções está ligada: quem conferiu o comprovante não valida a mesma venda.");
      // KAN-31 V6: instantes de cada portão congelados aqui; nenhum pode ser posterior à validação (o Sales recusaria).
      const stamps = saleGateTimestamps({ documents: facts.documents, envelopes: facts.envelopes, contractSignedAt: signedAt, storedDocument: documentRow });
      // CRM-B1: com o gate de ordem ligado, comprovante E documentação conferidos ANTES de existir contrato (documento de contrato ou envelope).
      const orderGate = await saleOrderGateState(tx, input.contractId);
      if (orderGate.enabled && !orderGate.exempt) {
        if (!orderGate.documentsConferred) throw new GatesNotReady("gates", [], "A documentação ainda não foi conferida pelo administrativo (ordem da formalização).");
        const contractItems = [...facts.documents.filter(item => isContractDocumentCategory(item.category)), ...facts.envelopes];
        // Só documento/envelope DO CONTRATO conta: comprovante, aditivo e outros anexos subidos antes das conferências não antecedem a geração do contrato.
        const generatedAt = new Date(Math.min(...contractItems.map(item => item.createdAt?.getTime() ?? Infinity), documentRow.createdAt?.getTime() ?? Infinity));
        if (!conferralsBeforeGeneration({ contractGeneratedAt: generatedAt, receiptConferredAt: paymentConfirmedAt, documentsConferredAt: orderGate.documentsConferredAt! })) throw new GatesNotReady("timestamps", [], "O contrato foi gerado antes da conferência de comprovante e documentação (ordem da formalização).");
      }
      if (!gatesNotAfter({ ...stamps, paymentConfirmedAt }, validatedAt)) throw new GatesNotReady("timestamps", [], "Instante de portão posterior à validação (relógio ou dado inconsistente); confira a assinatura e o documento.");
      // Referência OPACA do documento assinado: a mesma vai para a trilha, para sale_validations e para o Sales (gates.documentRef).
      const documentRef = saleDocumentRef(input.contractId, document.id);

      const validationUpdate = await tx.update(saleValidations).set({ validatedAt, validatedByUserId: actorUserId, signedDocumentId: document.id, ...stamps, documentRef }).where(eq(saleValidations.contractId, input.contractId));
      if (affectedRows(validationUpdate) === 0) throw new TRPCError({ code: "CONFLICT", message: "Validação da venda alterada por outra operação. Recarregue." });
      const contractUpdate = await tx.update(contracts).set({ status: "active", activatedAt: validatedAt, signedAt, cancelledAt: undefined, cancellationReason: null }).where(and(eq(contracts.id, input.contractId), eq(contracts.status, locked.status)));
      if (affectedRows(contractUpdate) === 0) throw new TRPCError({ code: "CONFLICT", message: "O contrato foi alterado por outra operação. Recarregue e tente novamente." });
      await tx.insert(saleValidationEvents).values({
        contractId: input.contractId, step: "final_validated", actorUserId, occurredAt: validatedAt,
        beforeJson: JSON.stringify({ contractStatus: locked.status, validatedAt: null }),
        afterJson: JSON.stringify({ contractStatus: "active", validatedAt: validatedAt.toISOString(), validatedByUserId: actorUserId, signedDocumentId: document.id, paymentConfirmedAt: paymentConfirmedAt.toISOString(), paymentConfirmedByUserId, contractGeneratedAt: stamps.contractGeneratedAt.toISOString(), contractSignedAt: stamps.contractSignedAt.toISOString(), documentStoredAt: stamps.documentStoredAt.toISOString(), documentRef, attestation: SALE_VALIDATION_ATTESTATION, evidenceHash: saleEvidenceHash({ documentRef, paymentEvidenceRef: facts.validation!.paymentEvidenceRef ?? null, paymentConfirmationNote: facts.validation!.paymentConfirmationNote ?? null }) }),
        // Referência opaca, nunca storageKey/filename (podem carregar nome/CPF do cliente).
        reason: null, documentRef, correlationId, externalSaleId: saleId,
      });
      await txAudit(tx, { actorUserId, entityType: "contract", entityId: input.contractId, action: "status_updated", summary: "Status alterado para active (venda validada pelo gerente)." });
      await txAudit(tx, { actorUserId, entityType: "sale_validation", entityId: input.contractId, action: "validated", summary: `Venda do contrato ${input.contractId} validada (pagamento, contrato assinado e documento armazenado conferidos).`, idempotencyKey: `sale-validated:${input.contractId}` });
      // Mesmo evento da ativação de sempre: Relationship (crm.contract.activated.v1) e Financial (status) continuam dependendo dele.
      await txEvent(tx, { eventName: "contract.status.updated", aggregateType: "contract", aggregateId: input.contractId, actorUserId, payload: { status: "active", cancellationReason: null } });
      // CRM-C4: cotas oficiais da venda = frações ligadas ao contrato; contrato sem fração (ex.: importado) não afirma nada (campo ausente).
      const [quotaRow] = await tx.select({ n: sql<number>`COUNT(*)` }).from(commercialFractions).where(eq(commercialFractions.currentContractId, input.contractId));
      const quotasCount = Number(quotaRow?.n ?? 0);
      await txEvent(tx, { eventName: "sale.validated", aggregateType: "contract", aggregateId: input.contractId, actorUserId, payload: {
        contractId: input.contractId, saleId, ...(quotasCount >= 1 && quotasCount <= 100_000 ? { quotasCount } : {}),
        validatedAt: validatedAt.toISOString(), validatedByUserId: actorUserId, validatedBy: String(actorUserId),
        paymentConfirmedAt: paymentConfirmedAt.toISOString(), paymentConfirmedByUserId, paymentConfirmedBy: String(paymentConfirmedByUserId),
        contractGeneratedAt: stamps.contractGeneratedAt.toISOString(), contractSignedAt: stamps.contractSignedAt.toISOString(),
        documentStoredAt: stamps.documentStoredAt.toISOString(), documentRef,
      }, idempotencyKey: `sale-validated:${input.contractId}` });
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
    if (error.reason === "inventory") throw saleValidationError("CONFLICT", "INVENTORY_HELD_EXPIRED", error.detail);
    if (error.reason === "state") throw saleValidationError("CONFLICT", "SALE_VALIDATION_CONTRACT_STATE", error.detail);
    if (error.reason === "timestamps") throw saleValidationError("PRECONDITION_FAILED", "SALE_GATE_TIMESTAMP_INVALID", error.detail);
    if (error.reason === "document") throw saleValidationError("PRECONDITION_FAILED", "SALE_SIGNED_DOCUMENT_INVALID", error.detail);
    throw saleValidationError("PRECONDITION_FAILED", "SALE_VALIDATION_GATES_MISSING", error.detail, { missing: error.missing });
  }
}
