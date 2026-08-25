import { eq } from "drizzle-orm";
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
  list: adminProcedure.query(async () => { const db = await getDb(); if (!db) return []; return db.select({ resort: resorts, settings: commercialProjectSettings }).from(resorts).leftJoin(commercialProjectSettings, eq(commercialProjectSettings.resortId, resorts.id)).limit(1000); }),
  upsert: adminProcedure.input(settingsInput).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); const current = (await db.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, input.resortId)).limit(1))[0]; const values = { ...input, cancellationPolicy: normalizeJsonText(input.cancellationPolicy), requiredCaptureFields: normalizeJsonText(input.requiredCaptureFields), requiredContractDocuments: normalizeJsonText(input.requiredContractDocuments), commercialRoles: normalizeJsonText(input.commercialRoles), commissionPolicy: normalizeJsonText(input.commissionPolicy), updatedByUserId: ctx.user.id }; if (current) await db.update(commercialProjectSettings).set(values).where(eq(commercialProjectSettings.id, current.id)); else await db.insert(commercialProjectSettings).values(values); await recordAudit(ctx.user.id, "commercial_project_settings", input.resortId, current ? "updated" : "created", "Configuração comercial por empreendimento atualizada."); return { success: true }; }),
});
