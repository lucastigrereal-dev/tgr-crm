import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, masterDataOptions } from "../../drizzle/schema";
import { masterDataFieldLabel, masterDataFields, masterDataKey, type MasterDataField } from "../../shared/masterData";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, internalProcedure } from "./access";
import { affectedRows } from "../mysqlErrors";

/** Dicionários de cadastro (TSE #25): o administrador mantém as listas; a captação passa a aceitar só o que está nelas. */
const fieldInput = z.enum(masterDataFields);
const captureColumn = {
  captureLocation: captureRecords.captureLocation,
  transportation: captureRecords.transportation,
  vehicleBrand: captureRecords.vehicleBrand,
  partnerProfession: captureRecords.partnerProfession,
} as const;

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  return db;
}

/** Valores já usados nas fichas, agrupados pela chave do dicionário (a grafia mais usada representa o grupo). */
async function usedValues(field: MasterDataField) {
  const db = await requireDb();
  const column = captureColumn[field];
  const rows = await db.select({ value: column, total: sql<number>`count(*)` }).from(captureRecords).where(isNotNull(column)).groupBy(column).limit(2000);
  const groups = new Map<string, { value: string; total: number; best: number }>();
  for (const row of rows) {
    const value = row.value?.trim();
    if (!value) continue;
    const key = masterDataKey(value);
    const total = Number(row.total);
    const group = groups.get(key);
    if (!group) groups.set(key, { value, total, best: total });
    else { group.total += total; if (total > group.best) { group.value = value; group.best = total; } }
  }
  return groups;
}

export const masterDataRouter = router({
  list: internalProcedure.input(z.object({ field: fieldInput.optional(), includeInactive: z.boolean().default(false) }).default({ includeInactive: false })).query(async ({ input }) => {
    const db = await requireDb();
    const conditions = [input.field ? eq(masterDataOptions.field, input.field) : undefined, input.includeInactive ? undefined : eq(masterDataOptions.active, true)].filter(Boolean);
    return db.select({ id: masterDataOptions.id, field: masterDataOptions.field, value: masterDataOptions.value, active: masterDataOptions.active })
      .from(masterDataOptions).where(conditions.length ? and(...conditions) : undefined).orderBy(asc(masterDataOptions.field), asc(masterDataOptions.value)).limit(2000);
  }),

  add: adminProcedure.input(z.object({ field: fieldInput, value: z.string().trim().min(2, "Valor muito curto.").max(180) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const value = input.value.replace(/\s+/g, " ");
    const key = masterDataKey(value);
    const result = await db.transaction(async tx => {
      const [existing] = await tx.select().from(masterDataOptions).where(and(eq(masterDataOptions.field, input.field), eq(masterDataOptions.normalizedKey, key))).limit(1).for("update");
      if (existing?.active) throw new TRPCError({ code: "CONFLICT", message: `"${existing.value}" já está na lista de ${masterDataFieldLabel[input.field]}.` });
      // Opção desativada com a mesma chave volta para a lista com a grafia nova, sem duplicar.
      if (existing) {
        await tx.update(masterDataOptions).set({ active: true, value }).where(eq(masterDataOptions.id, existing.id));
        return { id: existing.id, reactivated: true };
      }
      const [created] = await tx.insert(masterDataOptions).values({ field: input.field, value, normalizedKey: key, createdByUserId: ctx.user.id }).$returningId();
      return { id: created.id, reactivated: false };
    });
    await recordAudit(ctx.user.id, "master_data_option", result.id, result.reactivated ? "reactivated" : "created", `${masterDataFieldLabel[input.field]}: "${value}" na lista.`);
    return result;
  }),

  setActive: adminProcedure.input(z.object({ id: z.number().int().positive(), active: z.boolean() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const [option] = await db.select().from(masterDataOptions).where(eq(masterDataOptions.id, input.id)).limit(1);
    if (!option) throw new TRPCError({ code: "NOT_FOUND", message: "Opção não encontrada." });
    const result = await db.update(masterDataOptions).set({ active: input.active }).where(and(eq(masterDataOptions.id, input.id), eq(masterDataOptions.active, !input.active)));
    if ((affectedRows(result) ?? 0) > 0) await recordAudit(ctx.user.id, "master_data_option", option.id, input.active ? "reactivated" : "deactivated", `${masterDataFieldLabel[option.field]}: "${option.value}" ${input.active ? "voltou para" : "saiu da"} lista.`);
    return { success: true };
  }),

  /** Monta a lista a partir do que as fichas já usam: cada grafia diferente da mesma chave vira uma opção só. */
  importExisting: adminProcedure.input(z.object({ field: fieldInput })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const groups = await usedValues(input.field);
    const added = await db.transaction(async tx => {
      const known = new Set((await tx.select({ normalizedKey: masterDataOptions.normalizedKey }).from(masterDataOptions).where(eq(masterDataOptions.field, input.field)).for("update")).map(row => row.normalizedKey));
      const fresh = Array.from(groups.entries()).filter(([key]) => !known.has(key) && key.length >= 2).map(([key, group]) => ({ field: input.field, value: group.value.replace(/\s+/g, " ").slice(0, 180), normalizedKey: key.slice(0, 180), createdByUserId: ctx.user.id }));
      if (fresh.length) await tx.insert(masterDataOptions).values(fresh);
      return fresh.length;
    });
    if (added) await recordAudit(ctx.user.id, "master_data_option", input.field, "imported", `${masterDataFieldLabel[input.field]}: ${added} opção(ões) criadas a partir das fichas.`);
    return { added, alreadyKnown: groups.size - added };
  }),

  /** Quanto das fichas já cabe na lista: valores usados fora da lista são o que falta limpar para a análise. */
  coverage: adminProcedure.input(z.object({ field: fieldInput })).query(async ({ input }) => {
    const db = await requireDb();
    const groups = await usedValues(input.field);
    const active = new Set((await db.select({ normalizedKey: masterDataOptions.normalizedKey }).from(masterDataOptions).where(and(eq(masterDataOptions.field, input.field), eq(masterDataOptions.active, true)))).map(row => row.normalizedKey));
    const outside = Array.from(groups.entries()).filter(([key]) => !active.has(key)).map(([, group]) => ({ value: group.value, total: group.total })).sort((a, b) => b.total - a.total);
    const totalCaptures = Array.from(groups.values()).reduce((sum, group) => sum + group.total, 0);
    return { activeOptions: active.size, totalCaptures, outsideCaptures: outside.reduce((sum, row) => sum + row.total, 0), outside: outside.slice(0, 50) };
  }),
});
