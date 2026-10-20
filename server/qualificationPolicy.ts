import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { qualificationPolicyVersions } from "../drizzle/schema";
import type { NqSettings } from "./captureSheetDomain";
import type { getDb } from "./db";

type Reader = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

/**
 * CRM-G1: política de qualificação (casal qualificado) com versão e vigência. Atrás de QUALIFICATION_POLICY_VERSIONING_ENABLED (padrão false):
 * desligada, só capture_sheet_settings vale (versão "legacy"), como antes. Ligada, vale a versão vigente de qualification_policy_versions; sem versão, "legacy".
 * Sem retroatividade: o resultado já gravado guarda a versão que o produziu (capture_records.nqPolicyVersion).
 */
export const LEGACY_QUALIFICATION_VERSION = "legacy";
export const isQualificationVersioningEnabled = () => process.env.QUALIFICATION_POLICY_VERSIONING_ENABLED === "true";

export const qualificationParamsSchema = z.strictObject({
  minManAge: z.number().int().min(0).max(120),
  minRelationshipMonths: z.number().int().min(0).max(600),
  minVehicleYear: z.number().int().min(1950).max(2100),
  minIncome: z.number().min(0).max(1_000_000),
  maxItemsAccepted: z.number().int().min(0).max(7),
  requireCreditCard: z.boolean(),
  requireOwnsHome: z.boolean(),
  vehicleKinds: z.array(z.enum(["carro", "moto"])).min(1).max(2),
});
export type QualificationParams = z.infer<typeof qualificationParamsSchema>;

/** Aplica a versão vigente sobre os limites do legado; devolve sempre a versão usada. */
export async function applyQualificationPolicy(reader: Reader, legacy: NqSettings, at: Date = new Date()): Promise<NqSettings> {
  if (!isQualificationVersioningEnabled()) return legacy;
  const row = (await reader.select({ version: qualificationPolicyVersions.version, paramsJson: qualificationPolicyVersions.paramsJson }).from(qualificationPolicyVersions).where(and(
    lte(qualificationPolicyVersions.effectiveAt, at), or(isNull(qualificationPolicyVersions.retiredAt), gt(qualificationPolicyVersions.retiredAt, at)),
  )).orderBy(desc(qualificationPolicyVersions.effectiveAt), desc(qualificationPolicyVersions.id)).limit(1))[0];
  if (!row) return { ...legacy, version: LEGACY_QUALIFICATION_VERSION };
  let params: QualificationParams | null = null;
  try { const parsed = qualificationParamsSchema.safeParse(JSON.parse(row.paramsJson)); params = parsed.success ? parsed.data : null; } catch { params = null; }
  // Versão vigente ilegível: volta ao legado (qualificação é apoio ao gerente, não dinheiro) mas deixa a versão marcada para o erro aparecer.
  if (!params) return { ...legacy, version: `${row.version}:invalid` };
  return { ...legacy, ...params, version: row.version };
}

/** Versão em vigor agora, para gravar na ficha no momento do NT / resultado comercial. */
export async function qualificationVersionToStamp(reader: Reader, legacy: NqSettings): Promise<string | null> {
  if (!isQualificationVersioningEnabled()) return null;
  return (await applyQualificationPolicy(reader, legacy)).version ?? LEGACY_QUALIFICATION_VERSION;
}
