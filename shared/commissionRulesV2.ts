import { z } from "zod";

// Regras de comissão V2 (decisão do Lucas, 19/10/2026): por papel, em CENTAVOS e pontos-base (bps), sem float.
// Aceita valor fixo por cota, percentual sobre a entrada efetiva e faixa por valor da entrada, com desconto da taxa da maquininha.
// É DADO configurável e versionado: nenhum motor de pagamento lê isto até o admin do sistema liberar a política (ADR-010: padrão 0%, nada é inventado).
// O motor abaixo é puro (sem banco, sem relógio) para poder ser provado com número na mão.

const bps = z.number().int().min(0).max(10_000);
const cents = z.number().int().min(0).max(100_000_000_00);

export const fixedPerQuotaRuleSchema = z.strictObject({ kind: z.literal("fixed_per_quota"), amountCents: cents });
export const percentOfEntryRuleSchema = z.strictObject({
  kind: z.literal("percent_of_effective_entry"),
  rateBps: bps,
  /** Tira a taxa da maquininha da entrada antes de aplicar o percentual. */
  deductMachineFee: z.boolean(),
});
export const tieredPercentRuleSchema = z.strictObject({
  kind: z.literal("tiered_percent_of_effective_entry"),
  /** Valor da entrada que separa as duas faixas. */
  thresholdCents: cents,
  /** true: "acima de" o limite entra na faixa de cima (o valor exato fica na de baixo). false: "a partir de". */
  strictlyAbove: z.boolean(),
  belowRateBps: bps,
  aboveRateBps: bps,
  /** Qual valor compara com o limite: a entrada bruta ou a efetiva (já sem a taxa). */
  tierBase: z.enum(["gross", "effective"]),
  deductMachineFee: z.boolean(),
});
export const roleRuleSchema = z.discriminatedUnion("kind", [fixedPerQuotaRuleSchema, percentOfEntryRuleSchema, tieredPercentRuleSchema]);

export const commissionRulesV2Schema = z.strictObject({
  schema: z.literal("tgr.commission-rules.v2"),
  /** Ex.: 1650 = 16,5% que a comercializadora fica sobre a venda (informativo; não é pago a pessoa). */
  companyRevenueBps: bps.optional(),
  /** Taxa padrão da maquininha; cada venda pode informar a taxa real em centavos. */
  machineFeeBps: bps,
  roles: z.strictObject({
    captador: roleRuleSchema.optional(),
    consultor: roleRuleSchema.optional(),
    fechador: roleRuleSchema.optional(),
  }),
  note: z.string().max(500).optional(),
});
export type CommissionRulesV2 = z.infer<typeof commissionRulesV2Schema>;
export type CommissionRoleV2 = keyof CommissionRulesV2["roles"];

export interface SaleForCommissionV2 {
  quotas: number;
  /** Entrada efetivamente recebida, em centavos (bruta, antes da taxa). */
  entryCents: number;
  /** Taxa real cobrada pela maquininha nesta venda; se ausente usa machineFeeBps. */
  machineFeeCents?: number;
  /** Valor total da venda em centavos; só para o informativo da receita da comercializadora. */
  saleTotalCents?: number;
}

export interface CommissionLineV2 { role: CommissionRoleV2; amountCents: number; basis: string }
export interface CommissionResultV2 { effectiveEntryCents: number; machineFeeCents: number; lines: CommissionLineV2[]; companyRevenueCents: number | null }

const pct = (valueCents: number, rateBps: number) => Math.floor((valueCents * rateBps + 5_000) / 10_000);

/** Calcula as comissões da venda pelas regras V2. Entrada/cotas inválidas viram erro (nunca zero silencioso). */
export function computeCommissionV2(rulesInput: unknown, sale: SaleForCommissionV2): CommissionResultV2 {
  const rules = commissionRulesV2Schema.parse(rulesInput);
  if (!Number.isInteger(sale.quotas) || sale.quotas < 0) throw new Error("quotas must be a non-negative integer");
  if (!Number.isInteger(sale.entryCents) || sale.entryCents < 0) throw new Error("entryCents must be a non-negative integer");
  if (sale.machineFeeCents !== undefined && (!Number.isInteger(sale.machineFeeCents) || sale.machineFeeCents < 0)) throw new Error("machineFeeCents must be a non-negative integer");
  const machineFeeCents = Math.min(sale.entryCents, sale.machineFeeCents ?? pct(sale.entryCents, rules.machineFeeBps));
  const effectiveEntryCents = sale.entryCents - machineFeeCents;
  const lines: CommissionLineV2[] = [];
  for (const role of ["captador", "consultor", "fechador"] as const) {
    const rule = rules.roles[role];
    if (!rule) continue;
    const base = (deduct: boolean) => (deduct ? effectiveEntryCents : sale.entryCents);
    if (rule.kind === "fixed_per_quota") lines.push({ role, amountCents: rule.amountCents * sale.quotas, basis: `${sale.quotas} cota(s) x ${rule.amountCents} centavos` });
    else if (rule.kind === "percent_of_effective_entry") lines.push({ role, amountCents: pct(base(rule.deductMachineFee), rule.rateBps), basis: `${rule.rateBps} bps sobre ${base(rule.deductMachineFee)} centavos` });
    else {
      const compared = rule.tierBase === "gross" ? sale.entryCents : effectiveEntryCents;
      const above = rule.strictlyAbove ? compared > rule.thresholdCents : compared >= rule.thresholdCents;
      const rate = above ? rule.aboveRateBps : rule.belowRateBps;
      lines.push({ role, amountCents: pct(base(rule.deductMachineFee), rate), basis: `faixa ${above ? "de cima" : "de baixo"} (${rate} bps) sobre ${base(rule.deductMachineFee)} centavos` });
    }
  }
  return { effectiveEntryCents, machineFeeCents, lines, companyRevenueCents: rules.companyRevenueBps === undefined || sale.saleTotalCents === undefined ? null : pct(sale.saleTotalCents, rules.companyRevenueBps) };
}

/**
 * Rascunho da regra da Five ditada pelo Lucas em 19/10/2026 (14:17Z e confirmada 15:21Z). É DADO NÃO LIBERADO: o admin do sistema confere e libera.
 * Confirmado pelo Lucas: R$ 3.990 exato já é a faixa de cima (15%); tudo é calculado sobre o LÍQUIDO (entrada menos a taxa da maquininha),
 * inclusive a comparação com R$ 3.990; entrada abaixo de R$ 3.990 paga 10% ao fechador. A taxa real da maquininha (machineFeeBps) é configurável.
 */
export const FIVE_COMMISSION_DRAFT_V2: CommissionRulesV2 = {
  schema: "tgr.commission-rules.v2",
  companyRevenueBps: 1_650,
  machineFeeBps: 0,
  roles: {
    captador: { kind: "fixed_per_quota", amountCents: 40_000 },
    consultor: { kind: "percent_of_effective_entry", rateBps: 1_000, deductMachineFee: true },
    fechador: { kind: "tiered_percent_of_effective_entry", thresholdCents: 399_000, strictlyAbove: false, belowRateBps: 1_000, aboveRateBps: 1_500, tierBase: "effective", deductMachineFee: true },
  },
  note: "Rascunho da Five (ditado 19/10/2026). NÃO LIBERADO: depende de conferência do admin do sistema.",
};
