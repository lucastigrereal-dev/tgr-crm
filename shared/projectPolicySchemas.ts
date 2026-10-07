import { z } from "zod";

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
export const commissionPolicySchema = z
  .object({
    linerRate: z.number().finite().min(0).max(1).default(0),
    closerRate: z.number().finite().min(0).max(1).default(0),
    ftbRate: z.number().finite().min(0).max(1).default(0),
    cancellationDeadlineDay: z.number().int().min(1).max(28),
    expectedPaymentDay: z.number().int().min(1).max(28),
    eligiblePaymentMethods: z.array(commissionPaymentMethodSchema).min(1),
    basis: z.literal("eligible_receipt"),
  })
  .strict();

export type CommissionPolicy = z.infer<typeof commissionPolicySchema>;

export const commissionPolicyDraftSchema = commissionPolicySchema.partial();
export type CommissionPolicyDraft = z.infer<typeof commissionPolicyDraftSchema>;
