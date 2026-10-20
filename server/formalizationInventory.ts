import { and, asc, desc, eq, gt, inArray, isNull, or, lte } from "drizzle-orm";
import { z } from "zod";
import { commercialFractionHistory, commercialFractionHolds, commercialFractions, commercialPolicyVersions, contracts, saleValidations, tasks } from "../drizzle/schema";
import { txAudit, txEvent, type Tx } from "./txOutbox";

/**
 * CRM-E1: a cota só é VENDIDA depois que o administrativo conferiu comprovante E documentação. Até lá ela fica `held` com um hold de
 * `purpose='formalization'` ligado ao contrato, com prazo (TTL) definido por política administrativa versionada (`stock_hold`, padrão 48 h).
 * held -> sold acontece numa transação que relê as duas conferências com FOR UPDATE (contrato -> sale_validations -> cota -> hold, a mesma ordem do sweep).
 * Se o hold venceu antes: a cota volta ao estoque, o contrato recebe `inventoryLostAt`, nasce uma tarefa ao administrativo e a venda não valida (refazer).
 * Desligado por padrão (INVENTORY_HOLD_AT_FORMALIZATION): sem a flag, tudo segue como antes (cota vendida na criação do contrato).
 */
export const isInventoryHoldAtFormalizationEnabled = () => process.env.INVENTORY_HOLD_AT_FORMALIZATION === "true";
export const DEFAULT_FORMALIZATION_HOLD_HOURS = 48;
export const stockHoldPolicySchema = z.strictObject({ ttlHours: z.number().min(1).max(720) });

export async function formalizationHoldExpiry(tx: Pick<Tx, "select">, resortId: number | null, now: Date) {
  let ttlHours = DEFAULT_FORMALIZATION_HOLD_HOURS;
  if (resortId) {
    const row = (await tx.select({ policyJson: commercialPolicyVersions.policyJson }).from(commercialPolicyVersions).where(and(
      eq(commercialPolicyVersions.resortId, resortId), eq(commercialPolicyVersions.policyType, "stock_hold"), lte(commercialPolicyVersions.effectiveAt, now),
      or(isNull(commercialPolicyVersions.retiredAt), gt(commercialPolicyVersions.retiredAt, now)),
    )).orderBy(desc(commercialPolicyVersions.effectiveAt), desc(commercialPolicyVersions.id)).limit(1))[0];
    if (row) { try { const parsed = stockHoldPolicySchema.safeParse(JSON.parse(row.policyJson)); if (parsed.success) ttlHours = parsed.data.ttlHours; } catch { /* política ilegível: padrão */ } }
  }
  return new Date(now.getTime() + ttlHours * 3_600_000);
}

type Fraction = typeof commercialFractions.$inferSelect;
type Hold = typeof commercialFractionHolds.$inferSelect;

/** Cota (já travada FOR UPDATE) -> held por formalização do contrato. `existingHold` é o hold ativo (travado) de uma negociação, convertido em vez de duplicado. */
export async function holdFractionForFormalization(tx: Tx, fraction: Fraction, input: { contractId: number; proposalId: number | null; userId: number | null; now?: Date; existingHold?: Hold | null }) {
  const now = input.now ?? new Date();
  const expiresAt = await formalizationHoldExpiry(tx, fraction.resortId, now);
  if (input.existingHold) {
    await tx.update(commercialFractionHolds).set({ purpose: "formalization", contractId: input.contractId, expiresAt }).where(and(eq(commercialFractionHolds.id, input.existingHold.id), eq(commercialFractionHolds.status, "active")));
  } else {
    await tx.insert(commercialFractionHolds).values({ fractionId: fraction.id, proposalId: input.proposalId, heldByUserId: input.userId, purpose: "formalization", contractId: input.contractId, activeKey: `fraction:${fraction.id}`, status: "active", expiresAt });
  }
  await tx.update(commercialFractions).set({ status: "held", currentProposalId: input.proposalId, currentContractId: input.contractId, heldUntil: expiresAt, blockedReason: null }).where(eq(commercialFractions.id, fraction.id));
  await tx.insert(commercialFractionHistory).values({ fractionId: fraction.id, fromStatus: fraction.status, toStatus: "held", proposalId: input.proposalId, contractId: input.contractId, actorUserId: input.userId, reason: "Cota reservada na formalização do contrato (até a conferência de comprovante e documentação)" });
  await txAudit(tx, { actorUserId: input.userId, entityType: "commercial_fraction", entityId: fraction.id, action: "held_for_formalization", summary: `Cota reservada para o contrato ${input.contractId} até ${expiresAt.toISOString()}.` });
  await txEvent(tx, { eventName: "commercial.fraction.status.changed", aggregateType: "commercial_fraction", aggregateId: fraction.id, actorUserId: input.userId, payload: { fractionId: fraction.id, status: "held", proposalId: input.proposalId, contractId: input.contractId } });
  return { expiresAt };
}

/** Marca o contrato como "reserva perdida" e abre a tarefa do administrativo (idempotente). Só contratos ainda em formalização. */
export async function markContractInventoryLost(tx: Tx, contractId: number, actorUserId: number | null, now = new Date()) {
  const contract = (await tx.select({ id: contracts.id, number: contracts.number, status: contracts.status, customerId: contracts.customerId, inventoryLostAt: contracts.inventoryLostAt }).from(contracts).where(eq(contracts.id, contractId)).limit(1).for("update"))[0];
  if (!contract || contract.inventoryLostAt || !["draft", "pending_signature"].includes(contract.status)) return false;
  await tx.update(contracts).set({ inventoryLostAt: now }).where(eq(contracts.id, contractId));
  await txAudit(tx, { actorUserId, entityType: "contract", entityId: contractId, action: "inventory_lost", summary: `Reserva da cota do contrato ${contract.number} venceu antes da conferência; a cota voltou ao estoque. Refazer a venda.`, idempotencyKey: `inventory-lost:${contractId}` });
  await tx.insert(tasks).values({ title: `Reserva vencida: contrato ${contract.number}`, description: "A reserva da cota venceu antes da conferência de comprovante e documentação. A cota voltou ao estoque; refazer a venda.", type: "internal", priority: "high", customerId: contract.customerId, contractId, automationKey: `inventory-lost:${contractId}`, createdByUserId: actorUserId }).onDuplicateKeyUpdate({ set: { contractId } });
  return true;
}

export type SettleOutcome = { status: "off" | "pending" | "nothing" | "sold" | "lost"; fractionIds: number[] };

/**
 * Chamada DENTRO da transação de confirmPayment/confirmDocuments (contrato e sale_validations já travados nessa ordem). Relê as duas conferências com
 * FOR UPDATE; só quando ambas existem trava cotas e holds e faz held -> sold por compare-and-set. Hold ausente/vencido => cota ao estoque + contrato perdido.
 */
export async function settleFormalizationInventory(tx: Tx, contractId: number, actorUserId: number | null, now = new Date()): Promise<SettleOutcome> {
  if (!isInventoryHoldAtFormalizationEnabled()) return { status: "off", fractionIds: [] };
  const validation = (await tx.select({ paymentConfirmedAt: saleValidations.paymentConfirmedAt, documentsConferredAt: saleValidations.documentsConferredAt }).from(saleValidations).where(eq(saleValidations.contractId, contractId)).limit(1).for("update"))[0];
  if (!validation?.paymentConfirmedAt || !validation.documentsConferredAt) return { status: "pending", fractionIds: [] };
  const fractions = await tx.select().from(commercialFractions).where(and(eq(commercialFractions.currentContractId, contractId), eq(commercialFractions.status, "held"))).orderBy(asc(commercialFractions.id)).for("update");
  if (!fractions.length) {
    // Cota já devolvida por um sweep concorrente (hold de formalização vencido): a reserva foi perdida.
    const expiredHold = (await tx.select({ id: commercialFractionHolds.id }).from(commercialFractionHolds).where(and(eq(commercialFractionHolds.contractId, contractId), eq(commercialFractionHolds.purpose, "formalization"), eq(commercialFractionHolds.status, "expired"))).limit(1))[0];
    if (expiredHold) { await markContractInventoryLost(tx, contractId, actorUserId, now); return { status: "lost", fractionIds: [] }; }
    return { status: "nothing", fractionIds: [] };
  }
  const holds = await tx.select().from(commercialFractionHolds).where(and(inArray(commercialFractionHolds.fractionId, fractions.map(item => item.id)), eq(commercialFractionHolds.status, "active"), eq(commercialFractionHolds.contractId, contractId))).for("update");
  const alive = (fractionId: number) => holds.find(hold => hold.fractionId === fractionId && hold.purpose === "formalization" && hold.expiresAt.getTime() > now.getTime());
  const fractionIds = fractions.map(item => item.id);
  if (fractions.some(item => !alive(item.id))) {
    await tx.update(commercialFractionHolds).set({ status: "expired", activeKey: null, releasedAt: now, releaseReason: "Reserva de formalização vencida antes da conferência" }).where(inArray(commercialFractionHolds.id, holds.map(item => item.id).concat(0)));
    await tx.update(commercialFractions).set({ status: "available", currentContractId: null, currentProposalId: null, heldUntil: null }).where(and(inArray(commercialFractions.id, fractionIds), eq(commercialFractions.status, "held")));
    await tx.insert(commercialFractionHistory).values(fractionIds.map(fractionId => ({ fractionId, fromStatus: "held" as const, toStatus: "available" as const, contractId, actorUserId, reason: "Reserva de formalização vencida antes da conferência" })));
    await markContractInventoryLost(tx, contractId, actorUserId, now);
    return { status: "lost", fractionIds };
  }
  for (const fraction of fractions) {
    const hold = alive(fraction.id)!;
    await tx.update(commercialFractions).set({ status: "sold", heldUntil: null, blockedReason: null }).where(and(eq(commercialFractions.id, fraction.id), eq(commercialFractions.status, "held")));
    await tx.update(commercialFractionHolds).set({ status: "consumed", activeKey: null, releasedAt: now, releaseReason: "Consumido na conferência de comprovante e documentação" }).where(and(eq(commercialFractionHolds.id, hold.id), eq(commercialFractionHolds.status, "active")));
    await tx.insert(commercialFractionHistory).values({ fractionId: fraction.id, fromStatus: "held", toStatus: "sold", proposalId: fraction.currentProposalId, contractId, actorUserId, reason: "Cota vendida após conferência de comprovante e documentação" });
    await txAudit(tx, { actorUserId, entityType: "commercial_fraction", entityId: fraction.id, action: "sold", summary: `Cota vendida ao contrato ${contractId} após as conferências.` });
    await txEvent(tx, { eventName: "commercial.fraction.status.changed", aggregateType: "commercial_fraction", aggregateId: fraction.id, actorUserId, payload: { fractionId: fraction.id, status: "sold", proposalId: fraction.currentProposalId, contractId } });
  }
  return { status: "sold", fractionIds };
}
