import { z } from "zod";
import { commissionRulesV2Schema } from "./commissionRulesV2";

export const commissionPaymentMethodSchema = z.enum([
  "pix",
  "debit",
  "credit",
  "boleto",
  "cash",
  "cheque",
  "other",
]);

/**
 * Política mínima necessária para que o motor possa gerar comissão automática.
 * Percentuais são frações (por exemplo, 0.02 = 2%). ADR-010: os percentuais por papel têm padrão 0% (0% = nenhum lançamento); demais campos sem fallback.
 */
/**
 * CRM-F2: calendário de pagamento da comissão. `full_upfront` = uma comissão por papel/contrato, no valor total, liberada na primeira parcela elegível paga
 * (a confirmação de recebimento da entrada); `per_installment` = proporcional a cada parcela paga (o comportamento histórico). Ausente = `full_upfront`
 * (padrão da empresa, configurável), mas DORMENTE: só o motor V2 lê, e ele segue travado por COMMISSION_V2_RELEASED. O V1 não muda.
 */
export const payoutScheduleSchema = z.strictObject({ mode: z.enum(["full_upfront", "per_installment"]) });
export const DEFAULT_PAYOUT_MODE = "full_upfront" as const;

export const commissionPolicySchema = z
  .object({
    linerRate: z.number().finite().min(0).max(1).default(0),
    closerRate: z.number().finite().min(0).max(1).default(0),
    ftbRate: z.number().finite().min(0).max(1).default(0),
    cancellationDeadlineDay: z.number().int().min(1).max(28),
    expectedPaymentDay: z.number().int().min(1).max(28),
    eligiblePaymentMethods: z.array(commissionPaymentMethodSchema).min(1),
    basis: z.literal("eligible_receipt"),
    /** Regras V2 (CRM-A13): dado configurável; só valem quando a política V2 for LIBERADA (COMMISSION_V2_RELEASED). Travado por padrão. */
    rulesV2: commissionRulesV2Schema.optional(),
    payoutSchedule: payoutScheduleSchema.optional(),
    /** CRM-F3: comissão já paga em contrato distratado. Nunca estorna sozinho: `manual_review` abre a fila manual (ADR-010), `none` só audita. Só vale com COMMISSION_CANCEL_POLICY_ENABLED. */
    onPaidCommissionCancellation: z.enum(["none", "manual_review"]).optional(),
  })
  .strict();

export type CommissionPolicy = z.infer<typeof commissionPolicySchema>;

export const commissionPolicyDraftSchema = commissionPolicySchema.partial();
export type CommissionPolicyDraft = z.infer<typeof commissionPolicyDraftSchema>;
