import { eq } from "drizzle-orm";
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
 * Conciliação de um lançamento com o extrato: promove a `bank_reconciled` SOMENTE a parcela explicitamente vinculada ao lançamento
 * (`financial_transactions.installmentId`, gravado pela baixa manual e pelo webhook) e só para lançamento de ENTRADA (income).
 * Nunca infere por contrato+valor: sem vínculo (ex.: entrada informada pelo Sales) ou com despesa/estorno, não promove e deixa auditoria.
 */
export async function promoteInstallmentsOnReconcile(tx: Tx, input: { entryId: number; entryType: "income" | "expense"; installmentId: number | null; actorUserId: number | null }) {
  const skip = async (reason: string) => {
    await txAudit(tx, { actorUserId: input.actorUserId, entityType: "financial_transaction", entityId: input.entryId, action: "reconcile_installments_skipped", summary: `Conciliação não promoveu parcela: ${reason}.` });
    return { promoted: [] as number[] };
  };
  if (input.entryType !== "income") return skip("lançamento que não é entrada (despesa/estorno nunca promove)");
  if (!input.installmentId) return skip("sem vínculo explícito lançamento-parcela");
  const row = (await tx.select({ id: installments.id, paidAmount: installments.paidAmount, evidence: installments.settlementEvidence }).from(installments).where(eq(installments.id, input.installmentId)).limit(1).for("update"))[0];
  if (!row || Number(row.paidAmount) <= 0) return skip("a parcela vinculada não tem valor pago");
  if (row.evidence === "bank_reconciled") return { promoted: [] as number[] };
  await tx.update(installments).set({ settlementEvidence: "bank_reconciled" }).where(eq(installments.id, row.id));
  await txAudit(tx, { actorUserId: input.actorUserId, entityType: "financial_transaction", entityId: input.entryId, action: "reconcile_installments_promoted", summary: `Parcela ${row.id} promovida a conciliada com o extrato.` });
  return { promoted: [row.id] };
}
