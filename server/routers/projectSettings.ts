import { eq } from "drizzle-orm";
import { z } from "zod";
import { commercialProjectSettings, resorts } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure } from "./access";

const settingsInput = z.object({ resortId: z.number().int().positive(), cancellationPolicy: z.string().max(20_000).optional().nullable(), requiredCaptureFields: z.string().max(20_000).optional().nullable(), commercialRoles: z.string().max(20_000).optional().nullable(), commissionPolicy: z.string().max(20_000).optional().nullable() });
export const projectSettingsRouter = router({
  list: adminProcedure.query(async () => { const db = await getDb(); if (!db) return []; return db.select({ resort: resorts, settings: commercialProjectSettings }).from(resorts).leftJoin(commercialProjectSettings, eq(commercialProjectSettings.resortId, resorts.id)); }),
  upsert: adminProcedure.input(settingsInput).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new Error("Banco indisponível."); const current = (await db.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, input.resortId)).limit(1))[0]; const values = { ...input, updatedByUserId: ctx.user.id }; if (current) await db.update(commercialProjectSettings).set(values).where(eq(commercialProjectSettings.id, current.id)); else await db.insert(commercialProjectSettings).values(values); await recordAudit(ctx.user.id, "commercial_project_settings", input.resortId, current ? "updated" : "created", "Configuração comercial por empreendimento atualizada."); return { success: true }; }),
});
