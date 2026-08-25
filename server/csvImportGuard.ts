import { TRPCError } from "@trpc/server";

export const MAX_CSV_IMPORT_ROWS = 10_000;

export function assertCsvImportRowBudget(csv: string) {
  const rows = csv.split(/\r\n|\r|\n/).length;
  if (rows > MAX_CSV_IMPORT_ROWS + 1) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: `O arquivo excede o limite de ${MAX_CSV_IMPORT_ROWS.toLocaleString("pt-BR")} linhas.` });
  }
}
