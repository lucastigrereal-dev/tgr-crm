import { z } from "zod";

export const monetaryAdjustmentPolicySchema = z.object({
  indexCode: z.string().trim().min(1).max(40),
  periodicityMonths: z.coerce.number().int().min(1).max(24),
  spreadMonthlyPercent: z.coerce.number().min(0).max(10).default(0),
  applyTo: z.literal("open_installments").default("open_installments"),
  description: z.string().trim().max(500).optional(),
});

export type MonetaryAdjustmentPolicy = z.infer<typeof monetaryAdjustmentPolicySchema>;

export function parseMonetaryAdjustmentPolicy(value: unknown): MonetaryAdjustmentPolicy {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return monetaryAdjustmentPolicySchema.parse(parsed);
}

export function monthsBetween(baseDate: Date, throughDate: Date) {
  const base = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), 1));
  const through = new Date(Date.UTC(throughDate.getUTCFullYear(), throughDate.getUTCMonth(), 1));
  return (through.getUTCFullYear() - base.getUTCFullYear()) * 12 + (through.getUTCMonth() - base.getUTCMonth());
}

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const factor10 = (value: number) => Number(value.toFixed(10));

export type IndexValue = { referenceDate: Date | string; variationPercent: number | string };
export type AdjustableInstallment = { id: number; amount: number | string; sequence: number; status: string };

export function buildMonetaryAdjustment(input: {
  policy: MonetaryAdjustmentPolicy;
  baseDate: Date;
  throughDate: Date;
  indexValues: IndexValue[];
  installments: AdjustableInstallment[];
}) {
  if (input.throughDate.getTime() < input.baseDate.getTime()) throw new Error("through_before_base");
  const elapsedMonths = monthsBetween(input.baseDate, input.throughDate);
  if (elapsedMonths < input.policy.periodicityMonths) {
    return {
      eligible: false as const,
      reason: "periodicity_not_reached" as const,
      elapsedMonths,
      requiredMonths: input.policy.periodicityMonths,
      indexCode: input.policy.indexCode,
    };
  }

  const ordered = [...input.indexValues]
    .map(item => ({ referenceDate: new Date(item.referenceDate), variationPercent: Number(item.variationPercent) }))
    .filter(item => Number.isFinite(item.variationPercent))
    .sort((a, b) => a.referenceDate.getTime() - b.referenceDate.getTime());

  const indexFactorRaw = ordered.reduce((factor, item) => factor * (1 + item.variationPercent / 100), 1);
  const spreadFactorRaw = Math.pow(1 + input.policy.spreadMonthlyPercent / 100, elapsedMonths);
  const totalFactorRaw = indexFactorRaw * spreadFactorRaw;
  if (!Number.isFinite(totalFactorRaw) || totalFactorRaw <= 0) throw new Error("invalid_factor");

  const adjustedInstallments = input.installments.map(item => {
    const before = money(Number(item.amount));
    const after = money(before * totalFactorRaw);
    return { id: item.id, sequence: item.sequence, status: item.status, before, after, delta: money(after - before) };
  });
  const beforeTotal = money(adjustedInstallments.reduce((sum, item) => sum + item.before, 0));
  const afterTotal = money(adjustedInstallments.reduce((sum, item) => sum + item.after, 0));

  return {
    eligible: true as const,
    elapsedMonths,
    indexCode: input.policy.indexCode,
    periodicityMonths: input.policy.periodicityMonths,
    spreadMonthlyPercent: input.policy.spreadMonthlyPercent,
    indexFactor: factor10(indexFactorRaw),
    spreadFactor: factor10(spreadFactorRaw),
    totalFactor: factor10(totalFactorRaw),
    beforeTotal,
    afterTotal,
    deltaTotal: money(afterTotal - beforeTotal),
    indexValues: ordered.map(item => ({ referenceDate: item.referenceDate.toISOString().slice(0, 10), variationPercent: item.variationPercent })),
    installments: adjustedInstallments,
  };
}
