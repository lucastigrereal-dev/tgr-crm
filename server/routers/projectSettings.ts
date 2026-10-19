import { and, asc, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { auditLogs, commercialProjectSettings, resorts, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure } from "./access";
import { affectedRows } from "../mysqlErrors";

const jsonText = z.string().max(20_000).nullable().optional().superRefine((value, context) => {
  if (!value?.trim()) return;
  try {
    JSON.parse(value);
  } catch {
    context.addIssue({ code: "custom", message: "Informe um JSON válido." });
  }
});

const settingsInput = z.object({ resortId: z.number().int().positive(), cancellationPolicy: jsonText, requiredCaptureFields: jsonText, requiredContractDocuments: jsonText, commercialRoles: jsonText, commissionPolicy: jsonText, note: z.string().trim().max(500).optional() });

function normalizeJsonText(value: string | null | undefined) {
  return value?.trim() ? value.trim() : null;
}
const SETTING_FIELDS = ["cancellationPolicy", "requiredCaptureFields", "requiredContractDocuments", "commercialRoles", "commissionPolicy"] as const;
const AUDIT_ENTITY = "commercial_project_settings";

const clip = (value: string | null) => (value !== null && value.length > 2_000 ? `${value.slice(0, 2_000)}… (cortado)` : value);

/** Histórico por campo (de/para). Vai no texto da auditoria como JSON; leitura tolera linhas antigas, que só têm a frase genérica. */
export function describeSettingsChange(before: Record<string, string | null> | undefined, after: Record<string, string | null>, note?: string) {
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  for (const field of SETTING_FIELDS) {
    const from = before?.[field] ?? null;
    const to = after[field] ?? null;
    // O texto da auditoria é TEXT (64KB): cada de/para vai cortado em 2k para uma regra gigante nunca derrubar o registro.
    if (from !== to) changes[field] = { from: clip(from), to: clip(to) };
  }
  return { changes, ...(note ? { note } : {}) };
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
  history: adminProcedure.input(z.object({ resortId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select({ id: auditLogs.id, action: auditLogs.action, summary: auditLogs.summary, createdAt: auditLogs.createdAt, actorName: users.name })
      .from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(and(eq(auditLogs.entityType, AUDIT_ENTITY), eq(auditLogs.entityId, String(input.resortId)))).orderBy(desc(auditLogs.id)).limit(200);
    return rows.map(row => {
      let detail: ReturnType<typeof describeSettingsChange> | null = null;
      try { const parsed = JSON.parse(row.summary ?? ""); if (parsed && typeof parsed === "object" && parsed.changes) detail = parsed; } catch { /* linha antiga: sem de/para */ }
      return { id: row.id, action: row.action, createdAt: row.createdAt, actorName: row.actorName ?? null, changes: detail?.changes ?? null, note: detail?.note ?? null };
    });
  }),
  upsert: adminProcedure.input(settingsInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.transaction(async tx => {
      const resort = (await tx.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1).for("update"))[0];
      if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento não encontrado." });
      const current = (await tx.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, input.resortId)).limit(1))[0];
      const { note, ...settingValues } = input;
      const values = { ...settingValues, cancellationPolicy: normalizeJsonText(input.cancellationPolicy), requiredCaptureFields: normalizeJsonText(input.requiredCaptureFields), requiredContractDocuments: normalizeJsonText(input.requiredContractDocuments), commercialRoles: normalizeJsonText(input.commercialRoles), commissionPolicy: normalizeJsonText(input.commissionPolicy), updatedByUserId: ctx.user.id };
      if (current) {
        const updateResult = await tx.update(commercialProjectSettings).set(values).where(eq(commercialProjectSettings.id, current.id));
        if (affectedRows(updateResult) === 0) throw new TRPCError({ code: "CONFLICT", message: "A configuração foi alterada por outra operação. Recarregue e tente novamente." });
      } else {
        await tx.insert(commercialProjectSettings).values(values);
      }
      const kind = current ? "updated" as const : "created" as const;
      const change = describeSettingsChange(current ? Object.fromEntries(SETTING_FIELDS.map(field => [field, current[field] ?? null])) : undefined, Object.fromEntries(SETTING_FIELDS.map(field => [field, values[field] ?? null])), note);
      // O histórico entra na MESMA transação da mudança: ou grava os dois ou nenhum.
      await tx.insert(auditLogs).values({ actorUserId: ctx.user.id, entityType: AUDIT_ENTITY, entityId: String(input.resortId), action: kind, summary: JSON.stringify(change), idempotencyKey: null });
    });
    return { success: true };
  }),
});
