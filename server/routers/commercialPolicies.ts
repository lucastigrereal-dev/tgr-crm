import { and, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { commercialPolicyVersions, resorts } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, financeProcedure } from "./access";

const policyType = z.enum(["commission", "cancellation", "revenue_quality"]);

function isDuplicateKeyError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || Number(candidate.code) === 1062 || Number(candidate.errno) === 1062;
}

export const commercialPoliciesRouter = router({
  list: financeProcedure.input(z.object({ resortId: z.number().int().positive(), policyType: policyType.optional(), includeRetired: z.boolean().optional() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(commercialPolicyVersions).where(and(eq(commercialPolicyVersions.resortId, input.resortId), input.policyType ? eq(commercialPolicyVersions.policyType, input.policyType) : undefined, input.includeRetired ? undefined : isNull(commercialPolicyVersions.retiredAt))).orderBy(desc(commercialPolicyVersions.effectiveAt));
  }),

  create: adminProcedure.input(z.object({ resortId: z.number().int().positive(), policyType, version: z.string().trim().min(2).max(80), policy: z.record(z.string(), z.unknown()), effectiveAt: z.coerce.date().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const resort = (await db.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1))[0];
    if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento não encontrado." });
    const duplicate = (await db.select({ id: commercialPolicyVersions.id }).from(commercialPolicyVersions).where(and(eq(commercialPolicyVersions.resortId, input.resortId), eq(commercialPolicyVersions.policyType, input.policyType), eq(commercialPolicyVersions.version, input.version))).limit(1))[0];
    if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma versão com esse código para o empreendimento e tipo de política." });
    let created;
    try {
      created = await db.insert(commercialPolicyVersions).values({ resortId: input.resortId, policyType: input.policyType, version: input.version, policyJson: JSON.stringify(input.policy), effectiveAt: input.effectiveAt ?? new Date(), approvedByUserId: ctx.user.id }).$returningId();
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new TRPCError({ code: "CONFLICT", message: "A versão da política foi criada por outra operação." });
      throw error;
    }
    const id = created[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível versionar a política comercial." });
    await recordAudit(ctx.user.id, "commercial_policy_version", id, "created", `Política ${input.policyType} ${input.version} criada para empreendimento ${input.resortId}.`);
    return { id };
  }),

  retire: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const result = await db.update(commercialPolicyVersions).set({ retiredAt: new Date() }).where(and(eq(commercialPolicyVersions.id, input.id), isNull(commercialPolicyVersions.retiredAt)));
    if (result && typeof result === "object" && "affectedRows" in result && Number(result.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "A política já foi aposentada ou não existe." });
    await recordAudit(ctx.user.id, "commercial_policy_version", input.id, "retired", "Política comercial aposentada; histórico preservado.");
    return { success: true };
  }),
});
