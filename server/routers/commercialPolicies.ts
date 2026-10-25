import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { commercialPolicyVersions, resorts } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, financeProcedure } from "./access";
import { monetaryAdjustmentPolicySchema } from "../monetaryAdjustment";
import { parseCompleteCommissionPolicy } from "../projectPolicy";
import { DEFAULT_PAYOUT_MODE, DEFAULT_RELEASE_ON } from "../../shared/projectPolicySchemas";
import { stockHoldPolicySchema } from "../formalizationInventory";
import { saleTermsPolicySchema } from "../saleTermsPolicy";
import { affectedRows, isDuplicateKeyError } from "../mysqlErrors";

const policyType = z.enum(["commission", "cancellation", "revenue_quality", "monetary_adjustment", "sale_terms", "stock_hold"]);

/** Versão aprovada carrega o próprio significado: em full_upfront (inclusive o padrão, sem payoutSchedule) sem releaseOn, grava o default explícito. per_installment fica como está. */
export function materializeReleaseOn(policy: Record<string, unknown>): Record<string, unknown> {
  const schedule = (policy.payoutSchedule ?? {}) as { mode?: string; releaseOn?: string };
  const mode = schedule.mode ?? DEFAULT_PAYOUT_MODE;
  if (mode !== "full_upfront" || schedule.releaseOn) return policy;
  return { ...policy, payoutSchedule: { ...schedule, mode, releaseOn: DEFAULT_RELEASE_ON } };
}

export const commercialPoliciesRouter = router({
  list: financeProcedure.input(z.object({ resortId: z.number().int().positive(), policyType: policyType.optional(), includeRetired: z.boolean().optional(), limit: z.number().int().min(1).max(500).default(100) })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(commercialPolicyVersions).where(and(eq(commercialPolicyVersions.resortId, input.resortId), input.policyType ? eq(commercialPolicyVersions.policyType, input.policyType) : undefined, input.includeRetired ? undefined : isNull(commercialPolicyVersions.retiredAt))).orderBy(desc(commercialPolicyVersions.effectiveAt)).limit(input.limit);
  }),

  create: adminProcedure.input(z.object({ resortId: z.number().int().positive(), policyType, version: z.string().trim().min(2).max(80), policy: z.record(z.string(), z.unknown()), effectiveAt: z.coerce.date().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const resort = (await db.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1))[0];
    if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento não encontrado." });
    if (input.policyType === "monetary_adjustment") {
      const parsed = monetaryAdjustmentPolicySchema.safeParse(input.policy);
      if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: "Política monetária inválida. Informe indexCode, periodicityMonths, spreadMonthlyPercent e applyTo." });
    }
    // Vigência nunca retroativa para comissão e reserva: com o versionamento ligado, uma versão com data passada recalcularia o que já foi pago/reservado.
    if ((input.policyType === "commission" || input.policyType === "stock_hold") && input.effectiveAt && input.effectiveAt.getTime() < Date.now() - 60_000) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "A vigência não pode ser retroativa." });
    }
    if (input.policyType === "commission") {
      // Mesma validação do motor: política incompleta/ilegível não vira versão (o motor travado segue sem ler V2 enquanto COMMISSION_V2_RELEASED não for liberada).
      if (!parseCompleteCommissionPolicy(JSON.stringify(input.policy))) throw new TRPCError({ code: "BAD_REQUEST", message: "Política de comissão inválida ou incompleta." });
    }
    if (input.policyType === "stock_hold") {
      const parsed = stockHoldPolicySchema.safeParse(input.policy);
      if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: "Política de reserva inválida. Informe ttlHours entre 1 e 720." });
    }
    if (input.policyType === "sale_terms") {
      const parsed = saleTermsPolicySchema.safeParse(input.policy);
      if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: "Política de formalização inválida. Informe usageModel, balanceInstallmentCount e balanceCadenceMonths." });
    }
    // M-A08-02: janelas de vigência de comissão nunca se sobrepõem. A nova versão tem que começar DEPOIS de toda versão de comissão ainda aberta do empreendimento; empate ou inversão deixaria a versão do VENDEU ambígua.
    // A checagem e o insert rodam na mesma transação, com a linha do empreendimento travada, para dois admins simultâneos não passarem juntos.
    // A coluna guarda segundos inteiros: compara pelo segundo cheio para o empate não escapar por causa dos milissegundos.
    const startsAt = new Date(Math.floor((input.effectiveAt ?? new Date()).getTime() / 1000) * 1000);
    const insertVersion = async (tx: Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select" | "insert">) => {
      if (input.policyType === "commission") {
        await tx.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1).for("update");
        const overlapping = (await tx.select({ id: commercialPolicyVersions.id, version: commercialPolicyVersions.version }).from(commercialPolicyVersions).where(and(eq(commercialPolicyVersions.resortId, input.resortId), eq(commercialPolicyVersions.policyType, "commission"), isNull(commercialPolicyVersions.retiredAt), gte(commercialPolicyVersions.effectiveAt, startsAt))).limit(1))[0];
        if (overlapping) throw new TRPCError({ code: "CONFLICT", message: `A vigência se sobrepõe à versão ${overlapping.version}. Use uma data posterior à dela ou aposente a versão antes.` });
      }
      const duplicate = (await tx.select({ id: commercialPolicyVersions.id }).from(commercialPolicyVersions).where(and(eq(commercialPolicyVersions.resortId, input.resortId), eq(commercialPolicyVersions.policyType, input.policyType), eq(commercialPolicyVersions.version, input.version))).limit(1))[0];
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma versão com esse código para o empreendimento e tipo de política." });
      try {
        return await tx.insert(commercialPolicyVersions).values({ resortId: input.resortId, policyType: input.policyType, version: input.version, policyJson: JSON.stringify(input.policyType === "commission" ? materializeReleaseOn(input.policy) : input.policy), effectiveAt: input.effectiveAt ?? new Date(), approvedByUserId: ctx.user.id }).$returningId();
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new TRPCError({ code: "CONFLICT", message: "A versão da política foi criada por outra operação." });
        throw error;
      }
    };
    const created = input.policyType === "commission" ? await db.transaction(tx => insertVersion(tx)) : await insertVersion(db);
    const id = created[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível versionar a política comercial." });
    await recordAudit(ctx.user.id, "commercial_policy_version", id, "created", `Política ${input.policyType} ${input.version} criada para empreendimento ${input.resortId}.`);
    return { id };
  }),

  retire: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const result = await db.update(commercialPolicyVersions).set({ retiredAt: new Date() }).where(and(eq(commercialPolicyVersions.id, input.id), isNull(commercialPolicyVersions.retiredAt)));
    if (affectedRows(result) === 0) throw new TRPCError({ code: "CONFLICT", message: "A política já foi aposentada ou não existe." });
    await recordAudit(ctx.user.id, "commercial_policy_version", input.id, "retired", "Política comercial aposentada; histórico preservado.");
    return { success: true };
  }),
});
