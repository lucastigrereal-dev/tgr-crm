import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { commercialPolicyVersions } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, financeProcedure } from "./access";

const policyType = z.enum(["commission", "cancellation", "revenue_quality"]);

export const commercialPoliciesRouter = router({
  list: financeProcedure.input(z.object({ resortId: z.number().int().positive(), policyType: policyType.optional(), includeRetired: z.boolean().optional() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(commercialPolicyVersions).where(and(eq(commercialPolicyVersions.resortId, input.resortId), input.policyType ? eq(commercialPolicyVersions.policyType, input.policyType) : undefined, input.includeRetired ? undefined : isNull(commercialPolicyVersions.retiredAt))).orderBy(desc(commercialPolicyVersions.effectiveAt));
  }),

  create: adminProcedure.input(z.object({ resortId: z.number().int().positive(), policyType, version: z.string().trim().min(2).max(80), policy: z.record(z.string(), z.unknown()), effectiveAt: z.coerce.date().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Banco indisponível.");
    const created = await db.insert(commercialPolicyVersions).values({ resortId: input.resortId, policyType: input.policyType, version: input.version, policyJson: JSON.stringify(input.policy), effectiveAt: input.effectiveAt ?? new Date(), approvedByUserId: ctx.user.id }).$returningId();
    const id = created[0]?.id;
    if (!id) throw new Error("Não foi possível versionar a política comercial.");
    await recordAudit(ctx.user.id, "commercial_policy_version", id, "created", `Política ${input.policyType} ${input.version} criada para empreendimento ${input.resortId}.`);
    return { id };
  }),

  retire: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Banco indisponível.");
    await db.update(commercialPolicyVersions).set({ retiredAt: new Date() }).where(eq(commercialPolicyVersions.id, input.id));
    await recordAudit(ctx.user.id, "commercial_policy_version", input.id, "retired", "Política comercial aposentada; histórico preservado.");
    return { success: true };
  }),
});
