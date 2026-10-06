// WP11 (PRD v4 §13 / S81): registry MÍNIMO de política — só tipo, empreendimento, versão, status, vigência, aprovador,
// recibo e auditoria. NENHUM motor (comissão, distrato, índice, parcelas, Financial) lê este registry para calcular
// dinheiro: os motores continuam em commercial_policy_versions. Política aberta fica UNAPPROVED até documento aprovado.

export const OPEN_POLICY_TYPES = [
  "commission",            // comissão
  "cancellation_terms",    // distrato / multa / devolução
  "monetary_index",        // índice de correção
  "delinquency",           // inadimplência
  "retention",             // retenção
  "messaging",             // mensagens ao cliente
  "consent_final",         // consentimento final (LGPD)
  "contact_hours",         // horários de contato
] as const;
export type OpenPolicyType = (typeof OPEN_POLICY_TYPES)[number];

export const POLICY_STATUSES = ["DRAFT", "UNAPPROVED", "APPROVED", "RETIRED"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

const ALLOWED: Record<PolicyStatus, readonly PolicyStatus[]> = {
  DRAFT: ["UNAPPROVED", "RETIRED"],
  UNAPPROVED: ["DRAFT", "APPROVED", "RETIRED"],
  APPROVED: ["RETIRED"],
  RETIRED: [], // terminal: histórico preservado
};

export type TransitionCheck =
  | { ok: true }
  | { ok: false; code: "INVALID_TRANSITION" | "APPROVAL_EVIDENCE_REQUIRED"; message: string };

/** APPROVED é gate humano: só com aprovador nomeado e referência do recibo/documento aprovado. */
export function checkPolicyTransition(from: PolicyStatus, to: PolicyStatus, evidence: { approver?: string | null; receiptRef?: string | null }): TransitionCheck {
  if (!ALLOWED[from].includes(to)) return { ok: false, code: "INVALID_TRANSITION", message: `Transição ${from} → ${to} não permitida.` };
  if (to === "APPROVED" && (!evidence.approver?.trim() || !evidence.receiptRef?.trim())) {
    return { ok: false, code: "APPROVAL_EVIDENCE_REQUIRED", message: "Aprovar exige o nome de quem aprovou e a referência do documento/recibo aprovado." };
  }
  return { ok: true };
}
