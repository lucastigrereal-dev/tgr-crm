import { TRPCError } from "@trpc/server";

export const MAX_CSV_IMPORT_ROWS = 10_000;

export function assertCsvImportRowBudget(csv: string) {
  const rows = csv.split(/\r\n|\r|\n/).length;
  if (rows > MAX_CSV_IMPORT_ROWS + 1) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: `O arquivo excede o limite de ${MAX_CSV_IMPORT_ROWS.toLocaleString("pt-BR")} linhas.` });
  }
}

export function duplicateValueIndexes(values: readonly (string | null | undefined)[]) {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  values.forEach((value, index) => {
    const normalized = value?.trim().toLocaleLowerCase("pt-BR");
    if (!normalized) return;
    if (seen.has(normalized)) duplicates.push(index);
    else seen.add(normalized);
  });
  return duplicates;
}
