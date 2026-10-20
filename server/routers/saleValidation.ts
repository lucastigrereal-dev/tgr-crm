import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { captureSheetSettings, saleValidatorGrants, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { txAudit } from "../txOutbox";
import { assertSaleValidator, isSaleValidatorAuthorized, SEGREGATION_KEY } from "../saleValidatorAccess";
import { router } from "../_core/trpc";
import { confirmPayment, getValidationStatus, validateSale } from "../saleValidationService";
import { adminProcedure, assertCapability, contractsProcedure } from "./access";

async function requireDb() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); return db; }
const contractId = z.number().int().positive();

// CRM-C1: a validação oficial é do administrativo autorizado (admin, ou finance com concessão vigente). Não há gate final de gerente.
export const saleValidationRouter = router({
  getValidationStatus: contractsProcedure.input(z.object({ contractId })).query(({ ctx, input }) => {
    assertCapability(ctx.user.role, "sale.validation.view", "Somente administração e financeiro consultam a validação da venda.");
    return getValidationStatus(input.contractId);
  }),

  /** O usuário atual pode conferir/validar? (a tela só mostra o botão a quem o servidor aceitaria) */
  myAuthorization: contractsProcedure.query(async ({ ctx }) => ({ authorized: await isSaleValidatorAuthorized(ctx.user) })),

  grants: router({
    list: adminProcedure.query(async () => {
      const db = await requireDb();
      const rows = await db.select({ grant: saleValidatorGrants, userName: users.name, userRole: users.role }).from(saleValidatorGrants).innerJoin(users, eq(users.id, saleValidatorGrants.userId)).orderBy(desc(saleValidatorGrants.id)).limit(200);
      return { rows: rows.map(row => ({ ...row.grant, userName: row.userName, userRole: row.userRole })) };
    }),
    grant: adminProcedure.input(z.object({ userId: z.number().int().positive(), validUntil: z.coerce.date().optional().nullable(), note: z.string().trim().max(500).optional().nullable() })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      if (input.validUntil && input.validUntil.getTime() <= Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "A validade precisa ser futura." });
      return db.transaction(async tx => {
        const target = (await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, input.userId)).limit(1).for("update"))[0];
        if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Usuário não encontrado." });
        if (target.role !== "finance") throw new TRPCError({ code: "BAD_REQUEST", message: "A concessão vale para o perfil financeiro (administrativo). A administração já é autorizada." });
        const active = (await tx.select({ id: saleValidatorGrants.id }).from(saleValidatorGrants).where(and(eq(saleValidatorGrants.userId, target.id), isNull(saleValidatorGrants.revokedAt))).limit(1))[0];
        if (active) throw new TRPCError({ code: "CONFLICT", message: "Este usuário já tem concessão ativa. Revogue antes de conceder de novo." });
        const created = await tx.insert(saleValidatorGrants).values({ userId: target.id, grantedByUserId: ctx.user.id, validUntil: input.validUntil ?? null, note: input.note ?? null }).$returningId();
        await txAudit(tx, { actorUserId: ctx.user.id, entityType: "sale_validator_grant", entityId: created[0]!.id, action: "granted", summary: `Usuário ${target.id} autorizado a conferir e validar vendas${input.validUntil ? ` até ${input.validUntil.toISOString()}` : ""}.` });
        return { id: created[0]!.id };
      });
    }),
    revoke: adminProcedure.input(z.object({ grantId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db.transaction(async tx => {
        const row = (await tx.select().from(saleValidatorGrants).where(eq(saleValidatorGrants.id, input.grantId)).limit(1).for("update"))[0];
        if (!row || row.revokedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Concessão não encontrada ou já revogada." });
        await tx.update(saleValidatorGrants).set({ revokedAt: new Date(), revokedByUserId: ctx.user.id }).where(eq(saleValidatorGrants.id, row.id));
        await txAudit(tx, { actorUserId: ctx.user.id, entityType: "sale_validator_grant", entityId: row.id, action: "revoked", summary: `Concessão do usuário ${row.userId} revogada.` });
      });
      return { grantId: input.grantId };
    }),
  }),

  segregation: router({
    get: adminProcedure.query(async () => {
      const db = await requireDb();
      const [row] = await db.select().from(captureSheetSettings).where(eq(captureSheetSettings.key, SEGREGATION_KEY)).limit(1);
      return { enabled: row?.value === "1" };
    }),
    set: adminProcedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db.transaction(async tx => {
        const value = input.enabled ? "1" : "0";
        await tx.insert(captureSheetSettings).values({ key: SEGREGATION_KEY, value, provisional: true, updatedByUserId: ctx.user.id }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: ctx.user.id } });
        await txAudit(tx, { actorUserId: ctx.user.id, entityType: "sale_validation", entityId: 0, action: "segregation_changed", summary: `Segregação conferir/validar ${input.enabled ? "LIGADA" : "DESLIGADA"}.` });
      });
      return { enabled: input.enabled };
    }),
  }),

  confirmPayment: contractsProcedure.input(z.object({
    contractId,
    note: z.string().trim().min(3, "Informe a nota de conferência do pagamento.").max(2000),
    evidenceRef: z.string().trim().min(1).max(512).optional().nullable(),
  })).mutation(async ({ ctx, input }) => {
    await assertSaleValidator(ctx.user, "sale.payment.confirm", "Somente o administrativo autorizado confere o comprovante da venda.");
    return confirmPayment(ctx.user.id, input);
  }),

  validateSale: contractsProcedure.input(z.object({ contractId, signedDocumentId: z.number().int().positive().optional().nullable() })).mutation(async ({ ctx, input }) => {
    await assertSaleValidator(ctx.user, "sale.validate", "Somente o administrativo autorizado valida a venda.");
    return validateSale(ctx.user.id, input);
  }),
});
