import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { billingRecords, contractDocuments, contracts, csvImportBatches, csvImportItems, customers, financialTransactions, installments, ownershipEntitlements, reservationWaitlist, reservations, resorts, tasks, unitMaintenanceBlocks, units, users } from "../../drizzle/schema";
import { buildInstallmentSchedule } from "../domain";
import { getDb, recordAudit } from "../db";
import { applyCsvMapping, buildImportErrorReport, parseContractsCsv, parseCustomersCsv, parseUnitsCsv, suggestCsvMapping, type CsvColumnMapping, type ImportIssue, type ImportKind } from "../csvImport";
import { assertCsvImportRowBudget, duplicateValueIndexes } from "../csvImportGuard";
import { router } from "../_core/trpc";
import { adminProcedure } from "./access";

const inputSchema = z.object({ kind: z.enum(["customers", "contracts", "units"]), csv: z.string().min(2).max(2_000_000), mapping: z.record(z.string(), z.string()).optional() });
const parse = (kind: ImportKind, csv: string) => kind === "customers" ? parseCustomersCsv(csv) : kind === "contracts" ? parseContractsCsv(csv) : parseUnitsCsv(csv);
const canonicalCsv = (input: { csv: string; mapping?: CsvColumnMapping }) => applyCsvMapping(input.csv, input.mapping);
const importSummary = (totalRows: number, created: number, updated: number, issues: ImportIssue[]) => ({ processed: totalRows, created, updated, rejected: new Set(issues.map(issue => issue.line)).size, successful: created + updated, issuesByField: Object.entries(issues.reduce<Record<string, number>>((acc, issue) => ({ ...acc, [issue.field]: (acc[issue.field] ?? 0) + 1 }), {})).map(([field, count]) => ({ field, count })) });
const customerValues = (row: ReturnType<typeof parseCustomersCsv>["records"][number]) => ({ fullName: row.fullName, documentNumber: row.documentNumber, email: row.email, phone: row.phone, birthDate: row.birthDate ? new Date(`${row.birthDate}T12:00:00Z`) : null, maritalStatus: row.maritalStatus, occupation: row.occupation, zipCode: row.zipCode, address: row.address, addressNumber: row.addressNumber, complement: row.complement, neighborhood: row.neighborhood, city: row.city, state: row.state, acquisitionSource: row.acquisitionSource, status: row.status, notes: row.notes });
const restoreCustomerValues = (snapshot: Record<string, unknown>) => ({ fullName: String(snapshot.fullName ?? ""), documentNumber: snapshot.documentNumber ? String(snapshot.documentNumber) : null, email: snapshot.email ? String(snapshot.email) : null, phone: snapshot.phone ? String(snapshot.phone) : null, birthDate: snapshot.birthDate ? new Date(String(snapshot.birthDate)) : null, maritalStatus: snapshot.maritalStatus ? String(snapshot.maritalStatus) : null, occupation: snapshot.occupation ? String(snapshot.occupation) : null, zipCode: snapshot.zipCode ? String(snapshot.zipCode) : null, address: snapshot.address ? String(snapshot.address) : null, addressNumber: snapshot.addressNumber ? String(snapshot.addressNumber) : null, complement: snapshot.complement ? String(snapshot.complement) : null, neighborhood: snapshot.neighborhood ? String(snapshot.neighborhood) : null, city: snapshot.city ? String(snapshot.city) : null, state: snapshot.state ? String(snapshot.state) : null, acquisitionSource: snapshot.acquisitionSource ? String(snapshot.acquisitionSource) : null, status: (snapshot.status ?? "prospect") as "active" | "inactive" | "prospect", notes: snapshot.notes ? String(snapshot.notes) : null });
const normalizedKey = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
const unitValues = (row: ReturnType<typeof parseUnitsCsv>["records"][number]) => ({ code: row.code, category: row.category, capacity: row.capacity, beds: row.beds, status: row.status });
const restoreResortValues = (snapshot: Record<string, unknown>) => ({ name: String(snapshot.name ?? ""), city: snapshot.city ? String(snapshot.city) : null, state: snapshot.state ? String(snapshot.state) : null, status: (snapshot.status ?? "active") as "active" | "inactive" });
const restoreUnitValues = (snapshot: Record<string, unknown>) => ({ code: String(snapshot.code ?? ""), category: snapshot.category ? String(snapshot.category) : null, capacity: Number(snapshot.capacity ?? 2), beds: Number(snapshot.beds ?? 1), status: (snapshot.status ?? "active") as "active" | "maintenance" | "inactive" });

export const importsRouter = router({
  suggestMapping: adminProcedure.input(z.object({ kind: z.enum(["customers", "contracts", "units"]), csv: z.string().min(2).max(2_000_000) })).mutation(({ input }) => { assertCsvImportRowBudget(input.csv); return suggestCsvMapping(input.csv, input.kind); }),
  preview: adminProcedure.input(inputSchema).mutation(({ input }) => { assertCsvImportRowBudget(input.csv); const parsed = parse(input.kind, canonicalCsv(input)); return { valid: parsed.issues.length === 0, committed: false, totalRows: parsed.records.length, created: 0, updated: 0, issues: parsed.issues.slice(0, 100), sample: parsed.records.slice(0, 5), summary: importSummary(parsed.records.length, 0, 0, parsed.issues) }; }),
  errorReport: adminProcedure.input(inputSchema).mutation(({ input }) => { assertCsvImportRowBudget(input.csv); const parsed = parse(input.kind, canonicalCsv(input)); return { filename: `erros-importacao-${input.kind}.csv`, content: buildImportErrorReport(parsed.issues), totalIssues: parsed.issues.length }; }),
  latestBatch: adminProcedure.query(async () => { const db = await getDb(); if (!db) return null; const batch = await db.select().from(csvImportBatches).orderBy(desc(csvImportBatches.createdAt)).limit(1); if (!batch[0]) return null; const itemCount = await db.select({ total: count() }).from(csvImportItems).where(eq(csvImportItems.batchId, batch[0].id)); return { ...batch[0], itemCount: Number(itemCount[0]?.total ?? 0), canUndo: batch[0].status === "completed" }; }),
  commit: adminProcedure.input(inputSchema).mutation(async ({ ctx, input }) => {
    assertCsvImportRowBudget(input.csv);
    const csv = canonicalCsv(input); const parsed = parse(input.kind, csv); const issues: ImportIssue[] = [...parsed.issues];
    if (issues.length) return { valid: false, committed: false, totalRows: parsed.records.length, created: 0, updated: 0, issues: issues.slice(0, 100), sample: [], summary: importSummary(parsed.records.length, 0, 0, issues) };
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    if (input.kind === "customers") {
      const rows = parseCustomersCsv(csv).records; const documents = rows.map(row => row.documentNumber).filter(Boolean); const existing = documents.length ? await db.select().from(customers).where(inArray(customers.documentNumber, documents)) : []; const existingByDocument = new Map(existing.map(item => [item.documentNumber, item])); const duplicateCustomerRows = new Set(duplicateValueIndexes(rows.map(row => row.documentNumber)));
      rows.forEach((row, index) => { if (duplicateCustomerRows.has(index)) issues.push({ line: index + 2, field: "documentNumber", message: "Documento repetido dentro do próprio arquivo." }); });
      if (issues.length) return { valid: false, committed: false, totalRows: rows.length, created: 0, updated: 0, issues, sample: [], summary: importSummary(rows.length, 0, 0, issues) };
      let created = 0; let updated = 0; let batchId = 0;
      await db.transaction(async tx => {
        const createdBatch = await tx.insert(csvImportBatches).values({ kind: "customers", actorUserId: ctx.user.id, totalRows: rows.length }).$returningId(); batchId = createdBatch[0]?.id ?? 0; if (!batchId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível abrir o lote de importação." });
        for (const row of rows) { const values = customerValues(row); const before = existingByDocument.get(row.documentNumber); if (before) { await tx.update(customers).set(values).where(eq(customers.id, before.id)); await tx.insert(csvImportItems).values({ batchId, entityType: "customer", entityId: before.id, action: "updated", beforeSnapshot: JSON.stringify(before) }); updated += 1; } else { const inserted = await tx.insert(customers).values(values).$returningId(); const entityId = inserted[0]?.id; if (!entityId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar o associado importado." }); await tx.insert(csvImportItems).values({ batchId, entityType: "customer", entityId, action: "created" }); created += 1; } }
        await tx.update(csvImportBatches).set({ createdCount: created, updatedCount: updated, rejectedCount: 0 }).where(eq(csvImportBatches.id, batchId));
      });
      await recordAudit(ctx.user.id, "csv_import", batchId, "completed", `Lote ${batchId}: associados — ${created} criados e ${updated} atualizados.`);
      return { valid: true, committed: true, batchId, totalRows: rows.length, created, updated, issues: [] as ImportIssue[], sample: [], summary: importSummary(rows.length, created, updated, []) };
    }
    if (input.kind === "units") {
      const rows = parseUnitsCsv(csv).records;
      const resortNames = Array.from(new Set(rows.map(row => row.resortName).filter(Boolean)));
      const duplicateUnitRows = new Set(duplicateValueIndexes(rows.map(row => `${normalizedKey(row.resortName)}::${normalizedKey(row.code)}`)));
      const resortRows = resortNames.length ? await db.select().from(resorts).where(inArray(resorts.name, resortNames)) : [];
      const resortIds = resortRows.map(item => item.id);
      const unitRows = resortIds.length ? await db.select().from(units).where(inArray(units.resortId, resortIds)) : [];
      const resortsByName = new Map(resortRows.map(item => [normalizedKey(item.name), item]));
      const unitsByKey = new Map(unitRows.map(item => [`${item.resortId}::${normalizedKey(item.code)}`, item]));
      let created = 0; let updated = 0; let batchId = 0;
      rows.forEach((row, index) => { if (duplicateUnitRows.has(index)) issues.push({ line: index + 2, field: "codigo_unidade", message: "Código de unidade repetido no mesmo empreendimento dentro do arquivo." }); });
      if (issues.length) return { valid: false, committed: false, totalRows: rows.length, created: 0, updated: 0, issues: issues.slice(0, 100), sample: [], summary: importSummary(rows.length, 0, 0, issues) };
      await db.transaction(async tx => {
        const createdBatch = await tx.insert(csvImportBatches).values({ kind: "units", actorUserId: ctx.user.id, totalRows: rows.length }).$returningId(); batchId = createdBatch[0]?.id ?? 0;
        if (!batchId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível abrir o lote de inventário." });
        const touchedResorts = new Set<number>();
        for (const row of rows) {
          const resortKey = normalizedKey(row.resortName); let resort = resortsByName.get(resortKey);
          const resortValues = { name: row.resortName, city: row.resortCity, state: row.resortState, status: row.resortStatus };
          if (!resort) { const inserted = await tx.insert(resorts).values(resortValues).$returningId(); const resortId = inserted[0]?.id; if (!resortId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o empreendimento importado." }); resort = { id: resortId, ...resortValues, createdAt: new Date() }; resortsByName.set(resortKey, resort); await tx.insert(csvImportItems).values({ batchId, entityType: "resort", entityId: resortId, action: "created" }); }
          else if (!touchedResorts.has(resort.id)) { await tx.update(resorts).set(resortValues).where(eq(resorts.id, resort.id)); await tx.insert(csvImportItems).values({ batchId, entityType: "resort", entityId: resort.id, action: "updated", beforeSnapshot: JSON.stringify(resort) }); touchedResorts.add(resort.id); }
          const key = `${resort.id}::${normalizedKey(row.code)}`; const before = unitsByKey.get(key); const values = unitValues(row);
          if (before) { await tx.update(units).set(values).where(eq(units.id, before.id)); await tx.insert(csvImportItems).values({ batchId, entityType: "unit", entityId: before.id, action: "updated", beforeSnapshot: JSON.stringify(before) }); updated += 1; }
          else { const inserted = await tx.insert(units).values({ resortId: resort.id, ...values }).$returningId(); const unitId = inserted[0]?.id; if (!unitId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a unidade importada." }); unitsByKey.set(key, { id: unitId, resortId: resort.id, ...values, createdAt: new Date() }); await tx.insert(csvImportItems).values({ batchId, entityType: "unit", entityId: unitId, action: "created" }); created += 1; }
        }
        await tx.update(csvImportBatches).set({ createdCount: created, updatedCount: updated, rejectedCount: 0 }).where(eq(csvImportBatches.id, batchId));
      });
      await recordAudit(ctx.user.id, "csv_import", batchId, "completed", `Lote ${batchId}: inventário — ${created} unidades criadas e ${updated} atualizadas.`);
      return { valid: true, committed: true, batchId, totalRows: rows.length, created, updated, issues: [] as ImportIssue[], sample: [], summary: importSummary(rows.length, created, updated, []) };
    }
    const rows = parseContractsCsv(csv).records;
    const customerDocuments = Array.from(new Set(rows.map(row => row.customerDocument).filter(Boolean)));
    const sellerEmails = Array.from(new Set(rows.map(row => row.sellerEmail).filter((email): email is string => Boolean(email))));
    const contractNumbers = Array.from(new Set(rows.map(row => row.number).filter(Boolean)));
    const [customerRows, userRows, contractRows] = await Promise.all([
      customerDocuments.length ? db.select().from(customers).where(inArray(customers.documentNumber, customerDocuments)) : [],
      sellerEmails.length ? db.select().from(users).where(inArray(users.email, sellerEmails)) : [],
      contractNumbers.length ? db.select({ number: contracts.number }).from(contracts).where(inArray(contracts.number, contractNumbers)) : [],
    ]);
    const customerByDocument = new Map(customerRows.map(item => [item.documentNumber, item]));
    const userByEmail = new Map(userRows.filter(item => item.email).map(item => [item.email!.toLowerCase(), item]));
    const existingNumbers = new Set(contractRows.map(item => item.number));
    const duplicateContractRows = new Set(duplicateValueIndexes(rows.map(row => row.number)));
    rows.forEach((row, index) => { const line = index + 2; if (duplicateContractRows.has(index)) issues.push({ line, field: "numero_contrato", message: "Número de contrato repetido dentro do próprio arquivo." }); if (!customerByDocument.has(row.customerDocument)) issues.push({ line, field: "documento_associado", message: "Associado não encontrado; importe os associados antes dos contratos." }); if (existingNumbers.has(row.number)) issues.push({ line, field: "numero_contrato", message: "Este contrato já existe no sistema." }); if (row.sellerEmail && (!userByEmail.has(row.sellerEmail) || !["admin", "seller"].includes(userByEmail.get(row.sellerEmail)?.role ?? ""))) issues.push({ line, field: "email_vendedor", message: "Vendedor interno não encontrado por e-mail ou possui papel incompatível." }); });
    if (issues.length) return { valid: false, committed: false, totalRows: rows.length, created: 0, updated: 0, issues: issues.slice(0, 100), sample: [], summary: importSummary(rows.length, 0, 0, issues) };
    let created = 0; let batchId = 0;
    await db.transaction(async tx => { const createdBatch = await tx.insert(csvImportBatches).values({ kind: "contracts", actorUserId: ctx.user.id, totalRows: rows.length }).$returningId(); batchId = createdBatch[0]?.id ?? 0; if (!batchId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível abrir o lote de importação." }); for (const row of rows) { const customer = customerByDocument.get(row.customerDocument)!; const seller = row.sellerEmail ? userByEmail.get(row.sellerEmail) : undefined; const createdContract = await tx.insert(contracts).values({ number: row.number, customerId: customer.id, sellerId: seller?.id ?? ctx.user.id, usageModel: row.usageModel, status: row.status, totalAmount: row.totalAmount.toFixed(2), activatedAt: row.status === "active" ? new Date() : null, notes: row.notes }).$returningId(); const contractId = createdContract[0]?.id; if (!contractId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o contrato importado." }); const schedule = buildInstallmentSchedule(row.totalAmount, row.installmentCount, row.firstDueDate); await tx.insert(installments).values(schedule.map(item => ({ contractId, sequence: item.sequence, dueDate: item.dueDate, amount: item.amount, status: "open" as const }))); await tx.insert(csvImportItems).values({ batchId, entityType: "contract", entityId: contractId, action: "created" }); created += 1; } await tx.update(csvImportBatches).set({ createdCount: created, updatedCount: 0, rejectedCount: 0 }).where(eq(csvImportBatches.id, batchId)); });
    await recordAudit(ctx.user.id, "csv_import", batchId, "completed", `Lote ${batchId}: ${created} contratos criados.`);
    return { valid: true, committed: true, batchId, totalRows: rows.length, created, updated: 0, issues: [] as ImportIssue[], sample: [], summary: importSummary(rows.length, created, 0, []) };
  }),
  undoLast: adminProcedure.input(z.object({ confirm: z.literal(true) })).mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const outcome = await db.transaction(async tx => {
      const batches = await tx.select().from(csvImportBatches).orderBy(desc(csvImportBatches.createdAt)).limit(1).for("update");
      const batch = batches[0];
      if (!batch) throw new TRPCError({ code: "NOT_FOUND", message: "Ainda não há lote de importação para desfazer." });
      if (batch.status !== "completed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "O último lote já foi revertido e não pode ser desfeito novamente." });
      const items = await tx.select().from(csvImportItems).where(eq(csvImportItems.batchId, batch.id));

      if (batch.kind === "units") {
        const createdUnitIds = items.filter(item => item.entityType === "unit" && item.action === "created").map(item => item.entityId);
        if (createdUnitIds.length) {
          const [bookingRows, entitlementRows, blockRows] = await Promise.all([
            tx.select({ id: reservations.id }).from(reservations).where(inArray(reservations.unitId, createdUnitIds)),
            tx.select({ id: ownershipEntitlements.id }).from(ownershipEntitlements).where(inArray(ownershipEntitlements.unitId, createdUnitIds)),
            tx.select({ id: unitMaintenanceBlocks.id }).from(unitMaintenanceBlocks).where(inArray(unitMaintenanceBlocks.unitId, createdUnitIds)),
          ]);
          if (bookingRows.length || entitlementRows.length || blockRows.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não dá para desfazer: uma unidade importada já possui reserva, direito de uso ou bloqueio de manutenção vinculado." });
          await tx.delete(units).where(inArray(units.id, createdUnitIds));
        }
        for (const item of items.filter(item => item.entityType === "unit" && item.action === "updated" && item.beforeSnapshot)) await tx.update(units).set(restoreUnitValues(JSON.parse(item.beforeSnapshot!) as Record<string, unknown>)).where(eq(units.id, item.entityId));
        const createdResortIds = items.filter(item => item.entityType === "resort" && item.action === "created").map(item => item.entityId);
        if (createdResortIds.length) {
          const [unitRows, waitlistRows, entitlementRows] = await Promise.all([
            tx.select({ id: units.id }).from(units).where(inArray(units.resortId, createdResortIds)),
            tx.select({ id: reservationWaitlist.id }).from(reservationWaitlist).where(inArray(reservationWaitlist.resortId, createdResortIds)),
            tx.select({ id: ownershipEntitlements.id }).from(ownershipEntitlements).where(inArray(ownershipEntitlements.resortId, createdResortIds)),
          ]);
          if (unitRows.length || waitlistRows.length || entitlementRows.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não dá para desfazer: o empreendimento importado já possui unidade, fila ou direito de uso vinculado." });
          await tx.delete(resorts).where(inArray(resorts.id, createdResortIds));
        }
        for (const item of items.filter(item => item.entityType === "resort" && item.action === "updated" && item.beforeSnapshot)) await tx.update(resorts).set(restoreResortValues(JSON.parse(item.beforeSnapshot!) as Record<string, unknown>)).where(eq(resorts.id, item.entityId));
      } else if (batch.kind === "customers") {
        const createdIds = items.filter(item => item.entityType === "customer" && item.action === "created").map(item => item.entityId);
        if (createdIds.length) {
          const dependencies = await tx.select({ id: contracts.id }).from(contracts).where(inArray(contracts.customerId, createdIds));
          if (dependencies.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não dá para desfazer: associado importado já possui contrato vinculado." });
          await tx.delete(customers).where(inArray(customers.id, createdIds));
        }
        for (const item of items.filter(item => item.entityType === "customer" && item.action === "updated" && item.beforeSnapshot)) await tx.update(customers).set(restoreCustomerValues(JSON.parse(item.beforeSnapshot!) as Record<string, unknown>)).where(eq(customers.id, item.entityId));
      } else {
        const contractIds = items.filter(item => item.entityType === "contract" && item.action === "created").map(item => item.entityId);
        if (contractIds.length) {
          const installmentRows = await tx.select({ id: installments.id }).from(installments).where(inArray(installments.contractId, contractIds));
          const installmentIds = installmentRows.map(item => item.id);
          const [docs, bookings, taskRows, financial, billings] = await Promise.all([
            tx.select({ id: contractDocuments.id }).from(contractDocuments).where(inArray(contractDocuments.contractId, contractIds)),
            tx.select({ id: reservations.id }).from(reservations).where(inArray(reservations.contractId, contractIds)),
            tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.contractId, contractIds)),
            tx.select({ id: financialTransactions.id }).from(financialTransactions).where(inArray(financialTransactions.contractId, contractIds)),
            installmentIds.length ? tx.select({ id: billingRecords.id }).from(billingRecords).where(inArray(billingRecords.installmentId, installmentIds)) : Promise.resolve([]),
          ]);
          if (docs.length || bookings.length || taskRows.length || financial.length || billings.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não dá para desfazer: o contrato importado já possui documentos, reserva, tarefa, cobrança ou lançamento financeiro vinculado." });
          await tx.delete(installments).where(inArray(installments.contractId, contractIds));
          await tx.delete(contracts).where(inArray(contracts.id, contractIds));
        }
      }

      const batchUpdate = await tx.update(csvImportBatches).set({ status: "reverted", revertedAt: new Date(), revertedByUserId: ctx.user.id }).where(and(eq(csvImportBatches.id, batch.id), eq(csvImportBatches.status, "completed")));
      if (batchUpdate && typeof batchUpdate === "object" && "affectedRows" in batchUpdate && Number(batchUpdate.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "O lote foi alterado por outra operação. Recarregue e tente novamente." });
      return { batchId: batch.id, revertedItems: items.length, kind: batch.kind };
    });
    await recordAudit(ctx.user.id, "csv_import", outcome.batchId, "reverted", `Lote ${outcome.batchId} revertido com ${outcome.revertedItems} item(ns) auditado(s).`);
    return outcome;
  })
});
