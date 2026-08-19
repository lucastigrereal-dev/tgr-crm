import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { contracts, customers, installments, users } from "../../drizzle/schema";
import { buildInstallmentSchedule } from "../domain";
import { getDb, recordAudit } from "../db";
import { parseContractsCsv, parseCustomersCsv, type ImportIssue, type ImportKind } from "../csvImport";
import { router } from "../_core/trpc";
import { adminProcedure } from "./access";

const inputSchema = z.object({ kind: z.enum(["customers", "contracts"]), csv: z.string().min(2).max(2_000_000) });
const parse = (kind: ImportKind, csv: string) => kind === "customers" ? parseCustomersCsv(csv) : parseContractsCsv(csv);

export const importsRouter = router({
  preview: adminProcedure.input(inputSchema).mutation(({ input }) => {
    const parsed = parse(input.kind, input.csv);
    return { valid: parsed.issues.length === 0, committed: false, totalRows: parsed.records.length, created: 0, updated: 0, issues: parsed.issues.slice(0, 100), sample: parsed.records.slice(0, 5) };
  }),

  commit: adminProcedure.input(inputSchema).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const parsed = parse(input.kind, input.csv);
    const issues: ImportIssue[] = [...parsed.issues];
    if (input.kind === "customers") {
      const rows = parseCustomersCsv(input.csv).records;
      const documents = rows.map(row => row.documentNumber).filter(Boolean);
      const existing = documents.length ? await db.select().from(customers).where(inArray(customers.documentNumber, documents)) : [];
      const existingByDocument = new Map(existing.map(item => [item.documentNumber, item]));
      if (issues.length) return { valid: false, committed: false, totalRows: rows.length, created: 0, updated: 0, issues, sample: [] };
      let created = 0; let updated = 0;
      await db.transaction(async tx => {
        for (const row of rows) {
          const values = { fullName: row.fullName, documentNumber: row.documentNumber, email: row.email, phone: row.phone, birthDate: row.birthDate ? new Date(`${row.birthDate}T12:00:00Z`) : null, maritalStatus: row.maritalStatus, occupation: row.occupation, zipCode: row.zipCode, address: row.address, addressNumber: row.addressNumber, complement: row.complement, neighborhood: row.neighborhood, city: row.city, state: row.state, acquisitionSource: row.acquisitionSource, status: row.status, notes: row.notes };
          if (existingByDocument.has(row.documentNumber)) { await tx.update(customers).set(values).where(eq(customers.documentNumber, row.documentNumber)); updated += 1; }
          else { await tx.insert(customers).values(values); created += 1; }
        }
      });
      await recordAudit(ctx.user.id, "csv_import", 0, "completed", `Importação de associados: ${created} criados e ${updated} atualizados.`);
      return { valid: true, committed: true, totalRows: rows.length, created, updated, issues: [] as ImportIssue[], sample: [] };
    }

    const rows = parseContractsCsv(input.csv).records;
    const [customerRows, userRows, contractRows] = await Promise.all([
      db.select().from(customers), db.select().from(users), db.select({ number: contracts.number }).from(contracts),
    ]);
    const customerByDocument = new Map(customerRows.map(item => [item.documentNumber, item]));
    const userByEmail = new Map(userRows.filter(item => item.email).map(item => [item.email!.toLowerCase(), item]));
    const existingNumbers = new Set(contractRows.map(item => item.number));
    rows.forEach((row, index) => {
      const line = index + 2;
      if (!customerByDocument.has(row.customerDocument)) issues.push({ line, field: "documento_associado", message: "Associado não encontrado; importe os associados antes dos contratos." });
      if (existingNumbers.has(row.number)) issues.push({ line, field: "numero_contrato", message: "Este contrato já existe no sistema." });
      if (row.sellerEmail && !userByEmail.has(row.sellerEmail)) issues.push({ line, field: "email_vendedor", message: "Vendedor interno não encontrado por e-mail." });
    });
    if (issues.length) return { valid: false, committed: false, totalRows: rows.length, created: 0, updated: 0, issues: issues.slice(0, 100), sample: [] };
    let created = 0;
    await db.transaction(async tx => {
      for (const row of rows) {
        const customer = customerByDocument.get(row.customerDocument)!; const seller = row.sellerEmail ? userByEmail.get(row.sellerEmail) : undefined;
        const createdContract = await tx.insert(contracts).values({ number: row.number, customerId: customer.id, sellerId: seller?.id ?? ctx.user.id, usageModel: row.usageModel, status: row.status, totalAmount: row.totalAmount.toFixed(2), activatedAt: row.status === "active" ? new Date() : null, notes: row.notes }).$returningId();
        const contractId = createdContract[0]?.id;
        if (!contractId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o contrato importado." });
        const schedule = buildInstallmentSchedule(row.totalAmount, row.installmentCount, row.firstDueDate);
        await tx.insert(installments).values(schedule.map(item => ({ contractId, sequence: item.sequence, dueDate: item.dueDate, amount: item.amount, status: "open" as const })));
        created += 1;
      }
    });
    await recordAudit(ctx.user.id, "csv_import", 0, "completed", `Importação de contratos: ${created} contratos criados.`);
    return { valid: true, committed: true, totalRows: rows.length, created, updated: 0, issues: [] as ImportIssue[], sample: [] };
  }),
});
