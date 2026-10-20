import { and, asc, eq, gt, ne } from "drizzle-orm";
import { z } from "zod";
import { installments } from "../drizzle/schema";
import { txAudit, type Tx } from "./txOutbox";

/**
 * CRM-H1: comprovante conferido não é dinheiro recebido. Cada parcela paga carrega a EVIDÊNCIA do recebimento:
 * receipt_claimed (declarado) < gateway_confirmed (webhook) < bank_reconciled (extrato). Só sobe, nunca desce.
 * Dinheiro e comissão monetária seguem travados; esta camada só diz com que força o "pago" foi provado.
 */
export const SETTLEMENT_EVIDENCE = ["receipt_claimed", "gateway_confirmed", "bank_reconciled"] as const;
export type SettlementEvidence = (typeof SETTLEMENT_EVIDENCE)[number];
export const settlementEvidenceSchema = z.enum(SETTLEMENT_EVIDENCE);
export const DEFAULT_REQUIRED_EVIDENCE: SettlementEvidence = "receipt_claimed";

export const SETTLEMENT_EVIDENCE_LABEL: Record<SettlementEvidence, string> = {
  receipt_claimed: "Recebimento declarado",
  gateway_confirmed: "Confirmado pelo gateway",
  bank_reconciled: "Conciliado com o extrato",
};

const rank = (value: SettlementEvidence) => SETTLEMENT_EVIDENCE.indexOf(value);
export const evidenceSatisfies = (actual: SettlementEvidence, required: SettlementEvidence) => rank(actual) >= rank(required);
export const strongerEvidence = (a: SettlementEvidence, b: SettlementEvidence) => (rank(a) >= rank(b) ? a : b);

/** `requiredEvidence` de uma política (comissão, F1): ausente ou inválido = padrão `receipt_claimed`. */
export function requiredEvidenceOf(policyJson: string | Record<string, unknown> | null | undefined): SettlementEvidence {
  try {
    const parsed = typeof policyJson === "string" ? JSON.parse(policyJson) : policyJson;
    const value = settlementEvidenceSchema.safeParse((parsed as { requiredEvidence?: unknown } | null)?.requiredEvidence);
    return value.success ? value.data : DEFAULT_REQUIRED_EVIDENCE;
  } catch { return DEFAULT_REQUIRED_EVIDENCE; }
}

/** O campo só vai no evento `installment.paid` com a flag ligada (o Financial precisa aceitá-lo antes). */
export const isInstallmentEvidenceInEventEnabled = () => process.env.INSTALLMENT_EVIDENCE_IN_EVENT === "true";

/**
 * Conciliação de um lançamento com o extrato: promove a `bank_reconciled` as parcelas pagas do contrato cujo valor recebido soma EXATAMENTE o lançamento
 * (ordem de pagamento). Soma que não fecha = ambíguo: nada é promovido e fica auditoria.
 */
export function pickInstallmentsForEntry(candidates: Array<{ id: number; paidAmount: string }>, entryAmount: string) {
  const target = Math.round(Number(entryAmount) * 100);
  let sum = 0;
  const picked: number[] = [];
  for (const candidate of candidates) {
    const cents = Math.round(Number(candidate.paidAmount) * 100);
    if (cents <= 0) continue;
    if (sum + cents > target) continue;
    sum += cents; picked.push(candidate.id);
    if (sum === target) return picked;
  }
  return [];
}

export async function promoteInstallmentsOnReconcile(tx: Tx, input: { entryId: number; contractId: number | null; amount: string; actorUserId: number | null }) {
  if (!input.contractId) return { promoted: [] as number[], ambiguous: false };
  const candidates = await tx.select({ id: installments.id, paidAmount: installments.paidAmount }).from(installments)
    .where(and(eq(installments.contractId, input.contractId), gt(installments.paidAmount, "0.00"), ne(installments.settlementEvidence, "bank_reconciled")))
    .orderBy(asc(installments.paidAt), asc(installments.sequence)).for("update");
  const picked = pickInstallmentsForEntry(candidates, input.amount);
  if (!picked.length) {
    if (candidates.length) await txAudit(tx, { actorUserId: input.actorUserId, entityType: "financial_transaction", entityId: input.entryId, action: "reconcile_installments_ambiguous", summary: "Conciliação não promoveu parcelas: a soma recebida não fecha com o lançamento." });
    return { promoted: [], ambiguous: candidates.length > 0 };
  }
  for (const id of picked) await tx.update(installments).set({ settlementEvidence: "bank_reconciled" }).where(eq(installments.id, id));
  await txAudit(tx, { actorUserId: input.actorUserId, entityType: "financial_transaction", entityId: input.entryId, action: "reconcile_installments_promoted", summary: `Parcelas ${picked.join(", ")} promovidas a conciliadas com o extrato.` });
  return { promoted: picked, ambiguous: false };
}
