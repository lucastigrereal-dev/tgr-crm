import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { commercialPolicyVersions, commercialProjectSettings } from "../drizzle/schema";
import type { getDb } from "./db";
import { DEFAULT_PAYOUT_MODE, DEFAULT_RELEASE_ON_VERSIONED } from "../shared/projectPolicySchemas";
import { parseCompleteCommissionPolicy } from "./projectPolicy";

type Reader = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;
type Policy = NonNullable<ReturnType<typeof parseCompleteCommissionPolicy>>;

/**
 * CRM-F1: a política de comissão passa a ter VIGÊNCIA. Com COMMISSION_POLICY_VERSIONING_ENABLED ligada, a versão aplicada é a de
 * `commercial_policy_versions` (policyType 'commission') com effectiveAt <= data da parcela paga < retiredAt; sem versão vigente, vale o
 * legado `commercial_project_settings.commissionPolicy` (versão "legacy"). Desligada (padrão), só o legado é lido, como antes.
 * Este módulo NÃO decide se há comissão: o motor travado (COMMISSION_V2_RELEASED) e as taxas padrão 0% continuam valendo.
 */
export const isCommissionPolicyVersioningEnabled = () => process.env.COMMISSION_POLICY_VERSIONING_ENABLED === "true";
export const LEGACY_COMMISSION_POLICY_VERSION = "legacy";

const versionOfPolicy = new WeakMap<object, string>();
/** Código da versão que originou esta política (gravado em sales_commissions.policyVersion). */
export const commissionPolicyVersionOf = (policy: object | null | undefined) => (policy ? versionOfPolicy.get(policy) ?? null : null);

/**
 * Decisão do titular (21/10/2026): versões de política (commercial_policy_versions) pagam a comissão sobre a ENTRADA INTEIRA recebida quando `releaseOn` não
 * foi dito. O legado (commercial_project_settings, versão "legacy") NÃO passa por aqui e segue em `first_entry_installment`. Só vale com `full_upfront`.
 */
export function withVersionedPayoutDefaults(policy: Policy): Policy {
  const schedule = policy.payoutSchedule;
  const mode = schedule?.mode ?? DEFAULT_PAYOUT_MODE;
  if (mode !== "full_upfront" || schedule?.releaseOn) return policy;
  return { ...policy, payoutSchedule: { mode, releaseOn: DEFAULT_RELEASE_ON_VERSIONED } };
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
      const parsed = parseCompleteCommissionPolicy(row.policyJson);
      const policy = parsed ? withVersionedPayoutDefaults(parsed) : null;
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
export async function paidCommissionCancellationMode(tx: Reader, resortId: number | null | undefined): Promise<"none" | "manual_review"> {
  if (!isPaidCommissionCancellationPolicyEnabled()) return "manual_review";
  const resolved = await resolveCommissionPolicy(tx, resortId, new Date());
  return resolved.policy?.onPaidCommissionCancellation ?? "none";
}
