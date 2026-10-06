import { z } from "zod";
import { router } from "../_core/trpc";
import { confirmPayment, getValidationStatus, validateSale } from "../saleValidationService";
import { assertCapability, contractsProcedure } from "./access";

const contractId = z.number().int().positive();

// ADR-007: "gerente" do CRM = capacidades sale.payment.confirm / sale.validate, concedidas a admin.
export const saleValidationRouter = router({
  getValidationStatus: contractsProcedure.input(z.object({ contractId })).query(({ input }) => getValidationStatus(input.contractId)),

  confirmPayment: contractsProcedure.input(z.object({
    contractId,
    note: z.string().trim().min(3, "Informe a nota de conferência do pagamento.").max(2000),
    evidenceRef: z.string().trim().min(1).max(512).optional().nullable(),
  })).mutation(({ ctx, input }) => {
    assertCapability(ctx.user.role, "sale.payment.confirm", "Somente o gerente (administração) confirma o pagamento da venda.");
    return confirmPayment(ctx.user.id, input);
  }),

  validateSale: contractsProcedure.input(z.object({ contractId, signedDocumentId: z.number().int().positive().optional().nullable() })).mutation(({ ctx, input }) => {
    assertCapability(ctx.user.role, "sale.validate", "Somente o gerente (administração) valida a venda.");
    return validateSale(ctx.user.id, input);
  }),
});
