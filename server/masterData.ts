import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { masterDataOptions } from "../drizzle/schema";
import { masterDataFieldLabel, masterDataFields, masterDataKey, type MasterDataField } from "../shared/masterData";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Confere os campos com dicionário antes de gravar a captação. Campo sem opção ativa fica livre (o comportamento de
 * antes); com opções, o valor tem de bater com a lista e é gravado com a grafia dela. Vazio passa sempre.
 */
export async function canonicalizeMasterData(tx: Tx | Db, values: Partial<Record<MasterDataField, string | null | undefined>>) {
  const result: Partial<Record<MasterDataField, string | null | undefined>> = {};
  for (const field of masterDataFields) {
    const value = values[field];
    if (!value?.trim()) continue;
    const options = await tx.select({ value: masterDataOptions.value, normalizedKey: masterDataOptions.normalizedKey }).from(masterDataOptions)
      .where(and(eq(masterDataOptions.field, field), eq(masterDataOptions.active, true)));
    if (!options.length) continue;
    const match = options.find(option => option.normalizedKey === masterDataKey(value));
    if (!match) throw new TRPCError({ code: "BAD_REQUEST", message: `${masterDataFieldLabel[field]} "${value.trim()}" não está na lista. Escolha uma opção ou peça ao administrador para incluir em Dicionários.` });
    result[field] = match.value;
  }
  return result;
}
