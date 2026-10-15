import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, masterDataOptions } from "../../drizzle/schema";
import { isReservedMasterDataValue, MAX_ACTIVE_OPTIONS_PER_FIELD, MAX_TOTAL_OPTIONS_PER_FIELD, masterDataMaxLength, masterDataFieldLabel, masterDataFields, masterDataKey, type MasterDataField } from "../../shared/masterData";
import { getDb, recordAudit } from "../db";
import { withDeadlockRetry } from "../mysqlErrors";
import { router } from "../_core/trpc";
import { adminProcedure, internalProcedure } from "./access";

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

/**
 * Valores já usados nas fichas, agrupados pela chave do dicionário (a grafia mais usada representa o grupo). Lê todas as
 * grafias em páginas, sem cortar: importar e medir cobertura precisam do histórico inteiro. Valores reservados ficam de fora.
 */
async function usedValues(field: MasterDataField) {
  const db = await requireDb();
  const column = captureColumn[field];
  const groups = new Map<string, { value: string; total: number; best: number }>();
  const pageSize = 2000;
  for (let offset = 0; ; offset += pageSize) {
    // Agrupa pela grafia exata (collation binária): a collation do banco juntaria "Médica" e "MEDICA" antes de escolher a mais usada.
    const exact = sql<string>`${column} collate utf8mb4_bin`;
    const rows = await db.select({ value: exact, total: sql<number>`count(*)` }).from(captureRecords).where(isNotNull(column)).groupBy(exact).orderBy(exact).limit(pageSize).offset(offset);
    for (const row of rows) {
      const value = row.value?.trim();
      if (!value || isReservedMasterDataValue(field, value)) continue;
      const key = masterDataKey(value);
      const total = Number(row.total);
      const group = groups.get(key);
      if (!group) groups.set(key, { value, total, best: total });
      else { group.total += total; if (total > group.best) { group.value = value; group.best = total; } }
    }
    if (rows.length < pageSize) break;
  }
  return groups;
}

type Tx = Parameters<Parameters<Awaited<ReturnType<typeof requireDb>>["transaction"]>[0]>[0];
/**
 * Põe em fila todas as escritas da lista de um campo: trava todas as opções do campo (e o intervalo do índice, que barra
 * inserção concorrente no mesmo campo) antes de contar. Duas inclusões ao mesmo tempo nunca passam juntas do teto.
 */
async function lockField(tx: Tx, field: MasterDataField) {
  const rows = await tx.select({ id: masterDataOptions.id, normalizedKey: masterDataOptions.normalizedKey, active: masterDataOptions.active }).from(masterDataOptions).where(eq(masterDataOptions.field, field)).for("update");
  return { rows, activeCount: rows.filter(row => row.active).length };
}
const tooMany = (field: MasterDataField) => new TRPCError({ code: "PRECONDITION_FAILED", message: `A lista de ${masterDataFieldLabel[field]} chegou ao limite de ${MAX_ACTIVE_OPTIONS_PER_FIELD} opções ativas. Desative opções antes de incluir outras.` });
const tooManyStored = (field: MasterDataField) => new TRPCError({ code: "PRECONDITION_FAILED", message: `${masterDataFieldLabel[field]} já guarda ${MAX_TOTAL_OPTIONS_PER_FIELD} opções, contando as desativadas. Reative uma opção existente em vez de criar outra.` });

export const masterDataRouter = router({
  list: internalProcedure.input(z.object({ field: fieldInput.optional(), includeInactive: z.boolean().default(false) }).default({ includeInactive: false })).query(async ({ input }) => {
    const db = await requireDb();
    // Um campo por consulta: cada lista ativa cabe inteira no teto por campo, então nenhuma opção válida some da tela.
    const fields = input.field ? [input.field] : [...masterDataFields];
    const perField = await Promise.all(fields.map(field => db.select({ id: masterDataOptions.id, field: masterDataOptions.field, value: masterDataOptions.value, active: masterDataOptions.active })
      .from(masterDataOptions).where(input.includeInactive ? eq(masterDataOptions.field, field) : and(eq(masterDataOptions.field, field), eq(masterDataOptions.active, true)))
      .orderBy(desc(masterDataOptions.active), asc(masterDataOptions.value)).limit(input.includeInactive ? MAX_TOTAL_OPTIONS_PER_FIELD : MAX_ACTIVE_OPTIONS_PER_FIELD)));
    return perField.flat();
  }),

  add: adminProcedure.input(z.object({ field: fieldInput, value: z.string().trim().min(2, "Valor muito curto.").max(180) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const value = input.value.replace(/\s+/g, " ");
    if (value.length > masterDataMaxLength[input.field]) throw new TRPCError({ code: "BAD_REQUEST", message: `${masterDataFieldLabel[input.field]} aceita até ${masterDataMaxLength[input.field]} caracteres na ficha.` });
    if (isReservedMasterDataValue(input.field, value)) throw new TRPCError({ code: "BAD_REQUEST", message: `"${value}" é reservado para fichas criadas automaticamente e não entra na lista.` });
    const key = masterDataKey(value);
    const result = await withDeadlockRetry(() => db.transaction(async tx => {
      const locked = await lockField(tx, input.field);
      const [existing] = await tx.select().from(masterDataOptions).where(and(eq(masterDataOptions.field, input.field), eq(masterDataOptions.normalizedKey, key))).limit(1).for("update");
      if (existing?.active) throw new TRPCError({ code: "CONFLICT", message: `"${existing.value}" já está na lista de ${masterDataFieldLabel[input.field]}.` });
      if (locked.activeCount >= MAX_ACTIVE_OPTIONS_PER_FIELD) throw tooMany(input.field);
      // Opção desativada com a mesma chave volta para a lista com a grafia nova, sem duplicar.
      if (existing) {
        await tx.update(masterDataOptions).set({ active: true, value }).where(eq(masterDataOptions.id, existing.id));
        return { id: existing.id, reactivated: true };
      }
      if (locked.rows.length >= MAX_TOTAL_OPTIONS_PER_FIELD) throw tooManyStored(input.field);
      const [created] = await tx.insert(masterDataOptions).values({ field: input.field, value, normalizedKey: key, createdByUserId: ctx.user.id }).$returningId();
      return { id: created.id, reactivated: false };
    }));
    await recordAudit(ctx.user.id, "master_data_option", result.id, result.reactivated ? "reactivated" : "created", `${masterDataFieldLabel[input.field]}: "${value}" na lista.`);
    return result;
  }),

  setActive: adminProcedure.input(z.object({ id: z.number().int().positive(), active: z.boolean() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const [target] = await db.select({ field: masterDataOptions.field }).from(masterDataOptions).where(eq(masterDataOptions.id, input.id)).limit(1);
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Opção não encontrada." });
    const outcome = await withDeadlockRetry(() => db.transaction(async tx => {
      const locked = await lockField(tx, target.field);
      const [option] = await tx.select().from(masterDataOptions).where(eq(masterDataOptions.id, input.id)).limit(1);
      if (!option) throw new TRPCError({ code: "NOT_FOUND", message: "Opção não encontrada." });
      if (option.active === input.active) return { option, changed: false };
      if (input.active && locked.activeCount >= MAX_ACTIVE_OPTIONS_PER_FIELD) throw tooMany(option.field);
      await tx.update(masterDataOptions).set({ active: input.active }).where(eq(masterDataOptions.id, input.id));
      return { option, changed: true };
    }));
    if (outcome.changed) await recordAudit(ctx.user.id, "master_data_option", outcome.option.id, input.active ? "reactivated" : "deactivated", `${masterDataFieldLabel[outcome.option.field]}: "${outcome.option.value}" ${input.active ? "voltou para" : "saiu da"} lista.`);
    return { success: true };
  }),

  /** Monta a lista a partir do que as fichas já usam: cada grafia diferente da mesma chave vira uma opção só. */
  importExisting: adminProcedure.input(z.object({ field: fieldInput })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const groups = await usedValues(input.field);
    const added = await withDeadlockRetry(() => db.transaction(async tx => {
      const locked = await lockField(tx, input.field);
      const known = new Set(locked.rows.map(row => row.normalizedKey));
      const fresh = Array.from(groups.entries()).filter(([key]) => !known.has(key) && key.length >= 2).map(([key, group]) => ({ field: input.field, value: group.value.replace(/\s+/g, " ").slice(0, masterDataMaxLength[input.field]), normalizedKey: key.slice(0, 180), createdByUserId: ctx.user.id }));
      if (fresh.length && locked.activeCount + fresh.length > MAX_ACTIVE_OPTIONS_PER_FIELD) throw tooMany(input.field);
      if (fresh.length && locked.rows.length + fresh.length > MAX_TOTAL_OPTIONS_PER_FIELD) throw tooManyStored(input.field);
      for (let start = 0; start < fresh.length; start += 500) await tx.insert(masterDataOptions).values(fresh.slice(start, start + 500));
      return fresh.length;
    }));
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
