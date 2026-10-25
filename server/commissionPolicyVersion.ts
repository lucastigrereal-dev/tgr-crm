import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { captureRecords, commercialPolicyVersions, commercialProjectSettings, contracts, opportunities, proposals } from "../drizzle/schema";
import type { getDb } from "./db";
import { parseCompleteCommissionPolicy } from "./projectPolicy";

type Reader = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;
type Policy = NonNullable<ReturnType<typeof parseCompleteCommissionPolicy>>;

/**
 * CRM-F1: a política de comissão passa a ter VIGÊNCIA. Com COMMISSION_POLICY_VERSIONING_ENABLED ligada, a versão aplicada é a de
 * `commercial_policy_versions` (policyType 'commission') com effectiveAt <= data do VENDEU (D2=B, `commissionPolicyAnchor`) < retiredAt; sem versão vigente, vale o
 * legado `commercial_project_settings.commissionPolicy` (versão "legacy"). Desligada (padrão), só o legado é lido, como antes.
 * Este módulo NÃO decide se há comissão: o motor travado (COMMISSION_V2_RELEASED) e as taxas padrão 0% continuam valendo.
 */
export const isCommissionPolicyVersioningEnabled = () => process.env.COMMISSION_POLICY_VERSIONING_ENABLED === "true";
export const LEGACY_COMMISSION_POLICY_VERSION = "legacy";

const versionOfPolicy = new WeakMap<object, string>();
/** Código da versão que originou esta política (gravado em sales_commissions.policyVersion). */
export const commissionPolicyVersionOf = (policy: object | null | undefined) => (policy ? versionOfPolicy.get(policy) ?? null : null);

/**
 * Decisão D2=B (Lucas, 25/10): a VERSÃO da política de comissão é escolhida pela data do VENDEU (aceite comercial na sala), e não pela data da parcela paga nem por "hoje".
 * Isso NÃO autoriza pagar: o pagamento continua exigindo validação oficial do administrativo + entrada inteira (commissionBlockReason / isEntryFullyPaid).
 * Sem VENDEU registrado (venda importada ou fora da sala), a âncora é a criação do contrato (o fato original); só em último caso, agora.
 */
export function commissionPolicyAnchor(capture: { commercialOutcome?: string | null; commercialOutcomeAt?: Date | null } | null | undefined, contract: { createdAt?: Date | null } | null | undefined, now: Date = new Date()): Date {
  if (capture?.commercialOutcome === "vendeu" && capture.commercialOutcomeAt) return capture.commercialOutcomeAt;
  return contract?.createdAt ?? now;
}

/** Âncora da política de um contrato (VENDEU da ficha ligada pela proposta/oportunidade; senão criação do contrato). */
export async function loadCommissionPolicyAnchor(tx: Reader, contractId: number): Promise<{ anchor: Date; resortId: number | null }> {
  const [row] = await tx.select({ contract: contracts, capture: captureRecords }).from(contracts)
    .leftJoin(proposals, eq(contracts.proposalId, proposals.id)).leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id)).leftJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id))
    .where(eq(contracts.id, contractId)).orderBy(desc(captureRecords.createdAt)).limit(1);
  return { anchor: commissionPolicyAnchor(row?.capture, row?.contract), resortId: row?.capture?.resortId ?? row?.contract?.resortId ?? null };
}

export async function resolveCommissionPolicy(tx: Reader, resortId: number | null | undefined, at: Date): Promise<{ policy: Policy | null; version: string | null; source: "versioned" | "legacy" | "none" }> {
  if (!resortId) return { policy: null, version: null, source: "none" };
  if (isCommissionPolicyVersioningEnabled()) {
    const row = (await tx.select({ version: commercialPolicyVersions.version, policyJson: commercialPolicyVersions.policyJson }).from(commercialPolicyVersions).where(and(
      eq(commercialPolicyVersions.resortId, resortId), eq(commercialPolicyVersions.policyType, "commission"), lte(commercialPolicyVersions.effectiveAt, at),
      or(isNull(commercialPolicyVersions.retiredAt), gt(commercialPolicyVersions.retiredAt, at)),
    )).orderBy(desc(commercialPolicyVersions.effectiveAt), desc(commercialPolicyVersions.id)).limit(1))[0];
    if (row) {
      // Versão vigente ilegível = sem política (fecha, não cai no legado em silêncio): o motor bloqueia como "política ausente".
      const policy = parseCompleteCommissionPolicy(row.policyJson);
      if (policy) versionOfPolicy.set(policy, row.version);
      return { policy, version: row.version, source: "versioned" };
    }
  }
  const legacy = (await tx.select({ commissionPolicy: commercialProjectSettings.commissionPolicy }).from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, resortId)).limit(1))[0];
  const policy = parseCompleteCommissionPolicy(legacy?.commissionPolicy);
  if (policy) versionOfPolicy.set(policy, LEGACY_COMMISSION_POLICY_VERSION);
  return { policy, version: policy ? LEGACY_COMMISSION_POLICY_VERSION : null, source: policy ? "legacy" : "none" };
}

export const isPaidCommissionCancellationPolicyEnabled = () => process.env.COMMISSION_CANCEL_POLICY_ENABLED === "true";

/**
 * CRM-F3: política `onPaidCommissionCancellation` para comissão já paga de contrato distratado. NUNCA estorno/clawback automático: `manual_review` abre a fila manual
 * (ADR-010), `none` só registra auditoria informativa. Com COMMISSION_CANCEL_POLICY_ENABLED desligada (padrão) vale sempre `manual_review` (comportamento de hoje);
 * ligada, vale a política vigente do empreendimento e, se ela não disser, `none` (padrão da empresa, configurável).
 */
export async function paidCommissionCancellationMode(tx: Reader, resortId: number | null | undefined, at: Date = new Date()): Promise<"none" | "manual_review"> {
  if (!isPaidCommissionCancellationPolicyEnabled()) return "manual_review";
  // D2=B: a política do FATO ORIGINAL (VENDEU), não a vigente no dia do distrato. Quem chama passa a âncora (`loadCommissionPolicyAnchor`).
  const resolved = await resolveCommissionPolicy(tx, resortId, at);
  return resolved.policy?.onPaidCommissionCancellation ?? "none";
}
