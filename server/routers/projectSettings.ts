import { asc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { commercialProjectSettings, resorts } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure } from "./access";

const jsonText = z.string().max(20_000).nullable().optional().superRefine((value, context) => {
  if (!value?.trim()) return;
  try {
    JSON.parse(value);
  } catch {
    context.addIssue({ code: "custom", message: "Informe um JSON válido." });
  }
});

const settingsInput = z.object({ resortId: z.number().int().positive(), cancellationPolicy: jsonText, requiredCaptureFields: jsonText, requiredContractDocuments: jsonText, commercialRoles: jsonText, commissionPolicy: jsonText });

function normalizeJsonText(value: string | null | undefined) {
  return value?.trim() ? value.trim() : null;
}
export const projectSettingsRouter = router({
  list: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 1_000;
    const rawRows = await db.select({ resort: resorts, settings: commercialProjectSettings }).from(resorts).leftJoin(commercialProjectSettings, eq(commercialProjectSettings.resortId, resorts.id)).orderBy(asc(resorts.name)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["configurações por empreendimento"] : [] };
  }),
  upsert: adminProcedure.input(settingsInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const operation = await db.transaction(async tx => {
      const resort = (await tx.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1).for("update"))[0];
      if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento não encontrado." });
      const current = (await tx.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, input.resortId)).limit(1))[0];
      const values = { ...input, cancellationPolicy: normalizeJsonText(input.cancellationPolicy), requiredCaptureFields: normalizeJsonText(input.requiredCaptureFields), requiredContractDocuments: normalizeJsonText(input.requiredContractDocuments), commercialRoles: normalizeJsonText(input.commercialRoles), commissionPolicy: normalizeJsonText(input.commissionPolicy), updatedByUserId: ctx.user.id };
      if (current) {
        const updateResult = await tx.update(commercialProjectSettings).set(values).where(eq(commercialProjectSettings.id, current.id));
        if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "A configuração foi alterada por outra operação. Recarregue e tente novamente." });
      } else {
        await tx.insert(commercialProjectSettings).values(values);
      }
      return current ? "updated" as const : "created" as const;
    });
    await recordAudit(ctx.user.id, "commercial_project_settings", input.resortId, operation, "Configuração comercial por empreendimento atualizada.");
    return { success: true };
  }),
});
