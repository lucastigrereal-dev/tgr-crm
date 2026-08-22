import { eq, sql } from "drizzle-orm";
import { contractCancellationRequests, contracts, installments, revenueQualityLedger, salesCommissions } from "../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "./db";
import { summarizeRevenueQualityLedger } from "./revenueQualityLedger";
import { buildPersistableRevenueProjection } from "./revenueQualityProjection";

const POLICY_VERSION = "tgr-derived-ledger/v1";

/**
 * Recalcula a projeção derivada de um contrato depois que a fonte transacional
 * foi persistida. O índice único de fingerprint torna novas execuções seguras.
 */
export async function syncRevenueQualityForContract(input: { contractId: number; actorUserId: number; trigger: string }) {
  const db = await getDb();
  if (!db) throw new Error("Banco indisponível para sincronização do ledger.");
  const contract = (await db.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
  if (!contract) throw new Error("Contrato não encontrado para sincronização do ledger.");

  const [installmentRows, commissionRows, cancellationRows] = await Promise.all([
    db.select().from(installments).where(eq(installments.contractId, contract.id)),
    db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contract.id)),
    db.select().from(contractCancellationRequests).where(eq(contractCancellationRequests.contractId, contract.id)),
  ]);
  const cancellation = cancellationRows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  const projection = buildPersistableRevenueProjection({
    contract: { id: contract.id, totalAmount: contract.totalAmount, status: contract.status },
    installments: installmentRows.map(row => ({ id: row.id, sequence: row.sequence, amount: row.amount, status: row.status })),
    commissions: commissionRows.map(row => ({ id: row.id, amount: row.amount, status: row.status, lifecycleStatus: row.lifecycleStatus, sourceInstallmentId: row.sourceInstallmentId })),
    cancellation: cancellation ? { status: cancellation.status } : null,
    policyVersion: POLICY_VERSION,
  });
  if (projection.length) {
    await db.insert(revenueQualityLedger).values(projection.map(fact => ({
      contractId: fact.contractId,
      installmentId: fact.installmentId ?? null,
      commissionId: fact.commissionId ?? null,
      domainEventId: null,
      policyVersionId: null,
      factType: fact.type,
      amount: fact.amount.toFixed(2),
      reason: fact.reason ?? null,
      sourceFingerprint: fact.sourceFingerprint,
      occurredAt: new Date(),
    }))).onDuplicateKeyUpdate({ set: { sourceFingerprint: sql`sourceFingerprint` } });
  }
  await recordAudit(input.actorUserId, "revenue_quality_ledger", contract.id, "synced", `${projection.length} fato(s) econômicos projetados por ${input.trigger}.`);
  await recordDomainEvent({
    eventName: "revenue_quality_ledger.synced",
    aggregateType: "contract",
    aggregateId: contract.id,
    actorUserId: input.actorUserId,
    payload: { factCount: projection.length, policyVersion: POLICY_VERSION },
  });
  return { contractId: contract.id, factCount: projection.length, policyVersion: POLICY_VERSION, summary: summarizeRevenueQualityLedger(projection) };
}
