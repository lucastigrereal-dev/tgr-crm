import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { billingRecords, contractDocuments, contracts, csvImportBatches, csvImportItems, customers, financialPortfolioAssignments, financialTransactions, financialTransfers, installmentRenegotiations, installments, ownerPortalLinks, ownershipEntitlements, reservationWaitlist, reservations, resorts, revenueQualityLedger, saleValidationEvents, saleValidations, salesCommissions, tasks, unitMaintenanceBlocks, units, users } from "../../drizzle/schema";
import { recordInstallmentsScheduled } from "../installmentScheduledFacts";
import { txEvent } from "../txOutbox";
import { buildInstallmentSchedule } from "../domain";
import { getDb, recordAudit } from "../db";
import { assertCustomerNotAnonymized, ANONYMIZED_CUSTOMER_MESSAGE } from "../customerAnonymization";
import { applyCsvMapping, buildImportErrorReport, parseContractsCsv, parseCustomersCsv, parseUnitsCsv, suggestCsvMapping, type CsvColumnMapping, type ImportIssue, type ImportKind } from "../csvImport";
import { assertCsvImportRowBudget, duplicateValueIndexes } from "../csvImportGuard";
import { router } from "../_core/trpc";
import { adminProcedure } from "./access";
import { syncPreferredFromProfile } from "./customerContacts";
import { affectedRows, isForeignKeyBlockError } from "../mysqlErrors";

// Origem do lote (Gate 2 da migração): sistema de origem (ex.: "tse", "planilha_comercial") e nome do arquivo, ambos opcionais.
const inputSchema = z.object({ kind: z.enum(["customers", "contracts", "units"]), csv: z.string().min(2).max(2_000_000), mapping: z.record(z.string(), z.string()).optional(), sourceSystem: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,60}$/, "Sistema de origem: só letras, números, ponto, hífen e sublinhado (até 60).").optional(), sourceFileName: z.string().trim().min(1).max(255).optional() });
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** Impressão digital da linha normalizada (registro já interpretado): a mesma linha gera o mesmo hash em qualquer lote. */
const rowHash = (row: unknown) => sha256(JSON.stringify(row));
// sourceLine segue a numeração do relatório de erros (cabeçalho = 1, registro N = N + 1): linha em branco e quebra dentro de
// aspas não contam. A chave de rastreio é sourceRecordId + rowHash; sourceLine é só referência de posição.
const provenance = (index: number, sourceRecordId: string, row: unknown) => ({ sourceLine: index + 2, sourceRecordId: sourceRecordId.slice(0, 160), rowHash: rowHash(row) });
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Lote concluído (não revertido) com o mesmo conteúdo: só avisa, não bloqueia (reimportar o mesmo arquivo atualiza os mesmos registros). */
async function duplicateOfBatch(db: Db | null | undefined, kind: ImportKind, contentHash: string) {
  if (!db) return null;
  const rows = await db.select({ id: csvImportBatches.id }).from(csvImportBatches).where(and(eq(csvImportBatches.kind, kind), eq(csvImportBatches.contentHash, contentHash), eq(csvImportBatches.status, "completed"))).orderBy(desc(csvImportBatches.id)).limit(1);
  return rows[0]?.id ?? null;
}
/** Telefone/e-mail principal regravado pela importação ou pela reversão: o preferencial da lista de contatos acompanha. */
async function syncPrimaryContacts(tx: Parameters<typeof syncPreferredFromProfile>[0], customerId: number, values: { phone: string | null; email: string | null }, actorUserId: number) {
  await syncPreferredFromProfile(tx, customerId, "phone", values.phone, actorUserId);
  await syncPreferredFromProfile(tx, customerId, "email", values.email, actorUserId);
}
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
  preview: adminProcedure.input(inputSchema).mutation(async ({ input }) => { assertCsvImportRowBudget(input.csv); const csv = canonicalCsv(input); const parsed = parse(input.kind, csv); const contentHash = sha256(csv); return { valid: parsed.issues.length === 0, committed: false, totalRows: parsed.records.length, created: 0, updated: 0, issues: parsed.issues.slice(0, 100), sample: parsed.records.slice(0, 5), summary: importSummary(parsed.records.length, 0, 0, parsed.issues), contentHash, duplicateOfBatchId: await duplicateOfBatch(await getDb(), input.kind, contentHash) }; }),
  errorReport: adminProcedure.input(inputSchema).mutation(({ input }) => { assertCsvImportRowBudget(input.csv); const parsed = parse(input.kind, canonicalCsv(input)); return { filename: `erros-importacao-${input.kind}.csv`, content: buildImportErrorReport(parsed.issues), totalIssues: parsed.issues.length }; }),
  latestBatch: adminProcedure.query(async () => { const db = await getDb(); if (!db) return null; const batch = await db.select().from(csvImportBatches).orderBy(desc(csvImportBatches.createdAt)).limit(1); if (!batch[0]) return null; const itemCount = await db.select({ total: count() }).from(csvImportItems).where(eq(csvImportItems.batchId, batch[0].id)); return { ...batch[0], itemCount: Number(itemCount[0]?.total ?? 0), canUndo: batch[0].status === "completed" }; }),
  commit: adminProcedure.input(inputSchema).mutation(async ({ ctx, input }) => {
    assertCsvImportRowBudget(input.csv);
    const csv = canonicalCsv(input); const parsed = parse(input.kind, csv); const issues: ImportIssue[] = [...parsed.issues];
    if (issues.length) return { valid: false, committed: false, totalRows: parsed.records.length, created: 0, updated: 0, issues: issues.slice(0, 100), sample: [], summary: importSummary(parsed.records.length, 0, 0, issues) };
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const contentHash = sha256(csv);
    const origin = { sourceSystem: input.sourceSystem ?? "csv_manual", sourceFileName: input.sourceFileName ?? null, contentHash };
    // Consultado só quando o arquivo passou na validação, logo antes de abrir o lote.
    let duplicateOfBatchId: number | null = null;
    const checkDuplicate = async () => { duplicateOfBatchId = await duplicateOfBatch(db, input.kind, contentHash); };
    const originNote = () => ` Origem ${origin.sourceSystem}${origin.sourceFileName ? ` (${origin.sourceFileName})` : ""}, hash ${contentHash.slice(0, 12)}${duplicateOfBatchId ? `, mesmo conteúdo do lote ${duplicateOfBatchId}` : ""}.`;
    if (input.kind === "customers") {
      const rows = parseCustomersCsv(csv).records; const documents = rows.map(row => row.documentNumber).filter(Boolean); const existing = documents.length ? await db.select().from(customers).where(inArray(customers.documentNumber, documents)) : []; const existingByDocument = new Map(existing.map(item => [item.documentNumber, item])); const duplicateCustomerRows = new Set(duplicateValueIndexes(rows.map(row => row.documentNumber)));
      rows.forEach((row, index) => { if (duplicateCustomerRows.has(index)) issues.push({ line: index + 2, field: "documentNumber", message: "Documento repetido dentro do próprio arquivo." }); });
      rows.forEach((row, index) => { if (row.documentNumber && existingByDocument.get(row.documentNumber)?.anonymizedAt) issues.push({ line: index + 2, field: "documentNumber", message: ANONYMIZED_CUSTOMER_MESSAGE }); });
      if (issues.length) return { valid: false, committed: false, totalRows: rows.length, created: 0, updated: 0, issues, sample: [], summary: importSummary(rows.length, 0, 0, issues) };
      let created = 0; let updated = 0; let batchId = 0;
      await checkDuplicate();
      await db.transaction(async tx => {
        const createdBatch = await tx.insert(csvImportBatches).values({ kind: "customers", actorUserId: ctx.user.id, totalRows: rows.length, ...origin }).$returningId(); batchId = createdBatch[0]?.id ?? 0; if (!batchId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível abrir o lote de importação." });
        for (let index = 0; index < rows.length; index += 1) { const row = rows[index]!; const values = customerValues(row); const before = existingByDocument.get(row.documentNumber); const source = provenance(index, row.documentNumber, row); if (before) { await assertCustomerNotAnonymized(tx, before.id, { lock: true }); await tx.update(customers).set(values).where(eq(customers.id, before.id)); await syncPrimaryContacts(tx, before.id, values, ctx.user.id); await tx.insert(csvImportItems).values({ batchId, entityType: "customer", entityId: before.id, action: "updated", beforeSnapshot: JSON.stringify(before), ...source }); updated += 1; } else { const inserted = await tx.insert(customers).values(values).$returningId(); const entityId = inserted[0]?.id; if (!entityId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar o associado importado." }); await tx.insert(csvImportItems).values({ batchId, entityType: "customer", entityId, action: "created", ...source }); created += 1; } }
        await tx.update(csvImportBatches).set({ createdCount: created, updatedCount: updated, rejectedCount: 0 }).where(eq(csvImportBatches.id, batchId));
      });
      await recordAudit(ctx.user.id, "csv_import", batchId, "completed", `Lote ${batchId}: associados — ${created} criados e ${updated} atualizados.${originNote()}`);
      return { valid: true, committed: true, batchId, totalRows: rows.length, created, updated, issues: [] as ImportIssue[], sample: [], summary: importSummary(rows.length, created, updated, []), contentHash, duplicateOfBatchId };
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
      await checkDuplicate();
      await db.transaction(async tx => {
        const createdBatch = await tx.insert(csvImportBatches).values({ kind: "units", actorUserId: ctx.user.id, totalRows: rows.length, ...origin }).$returningId(); batchId = createdBatch[0]?.id ?? 0;
        if (!batchId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível abrir o lote de inventário." });
        const touchedResorts = new Set<number>();
        for (let index = 0; index < rows.length; index += 1) { const row = rows[index]!;
          const resortKey = normalizedKey(row.resortName);
          let resort = resortsByName.get(resortKey);
          const resortValues = { name: row.resortName, city: row.resortCity, state: row.resortState, status: row.resortStatus };
          if (!resort) {
            const inserted = await tx.insert(resorts).values(resortValues).$returningId();
            const resortId = inserted[0]?.id;
            if (!resortId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o empreendimento importado." });
            resort = { id: resortId, externalKey: null, ...resortValues, createdAt: new Date() };
            resortsByName.set(resortKey, resort);
            await tx.insert(csvImportItems).values({ batchId, entityType: "resort", entityId: resortId, action: "created", ...provenance(index, row.resortName, row) });
          } else if (!touchedResorts.has(resort.id)) {
            await tx.update(resorts).set(resortValues).where(eq(resorts.id, resort.id));
            await tx.insert(csvImportItems).values({ batchId, entityType: "resort", entityId: resort.id, action: "updated", beforeSnapshot: JSON.stringify(resort), ...provenance(index, row.resortName, row) });
            touchedResorts.add(resort.id);
          }
          if (!resort) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Empreendimento importado indisponível." });
          const key = `${resort.id}::${normalizedKey(row.code)}`;
          const before = unitsByKey.get(key);
          const values = unitValues(row);
          if (before) {
            await tx.update(units).set(values).where(eq(units.id, before.id));
            await tx.insert(csvImportItems).values({ batchId, entityType: "unit", entityId: before.id, action: "updated", beforeSnapshot: JSON.stringify(before), ...provenance(index, `${row.resortName}/${row.code}`, row) });
            updated += 1;
          } else {
            const inserted = await tx.insert(units).values({ resortId: resort.id, ...values }).$returningId();
            const unitId = inserted[0]?.id;
            if (!unitId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a unidade importada." });
            unitsByKey.set(key, { id: unitId, resortId: resort.id, ...values, createdAt: new Date() });
            await tx.insert(csvImportItems).values({ batchId, entityType: "unit", entityId: unitId, action: "created", ...provenance(index, `${row.resortName}/${row.code}`, row) });
            created += 1;
          }
        }
        await tx.update(csvImportBatches).set({ createdCount: created, updatedCount: updated, rejectedCount: 0 }).where(eq(csvImportBatches.id, batchId));
      });
      await recordAudit(ctx.user.id, "csv_import", batchId, "completed", `Lote ${batchId}: inventário — ${created} unidades criadas e ${updated} atualizadas.${originNote()}`);
      return { valid: true, committed: true, batchId, totalRows: rows.length, created, updated, issues: [] as ImportIssue[], sample: [], summary: importSummary(rows.length, created, updated, []), contentHash, duplicateOfBatchId };
    }
    const rows = parseContractsCsv(csv).records;
    const customerDocuments = Array.from(new Set(rows.map(row => row.customerDocument).filter(Boolean)));
    const sellerEmails = Array.from(new Set(rows.map(row => row.sellerEmail).filter((email): email is string => Boolean(email))));
    const contractNumbers = Array.from(new Set(rows.map(row => row.number).filter(Boolean)));
    const resortNames = Array.from(new Set(rows.map(row => row.resortName).filter((name): name is string => Boolean(name))));
    const resortRowsByName = new Map((resortNames.length ? await db.select({ id: resorts.id, name: resorts.name }).from(resorts) : []).map(item => [item.name.trim().toLocaleLowerCase("pt-BR"), item.id]));
    const [customerRows, userRows, contractRows] = await Promise.all([
      customerDocuments.length ? db.select().from(customers).where(inArray(customers.documentNumber, customerDocuments)) : [],
      sellerEmails.length ? db.select().from(users).where(inArray(users.email, sellerEmails)) : [],
      contractNumbers.length ? db.select({ number: contracts.number }).from(contracts).where(inArray(contracts.number, contractNumbers)) : [],
    ]);
    const customerByDocument = new Map(customerRows.map(item => [item.documentNumber, item]));
    const userByEmail = new Map(userRows.filter(item => item.email).map(item => [item.email!.toLowerCase(), item]));
    const existingNumbers = new Set(contractRows.map(item => item.number));
    const duplicateContractRows = new Set(duplicateValueIndexes(rows.map(row => row.number)));
    rows.forEach((row, index) => { const line = index + 2; if (duplicateContractRows.has(index)) issues.push({ line, field: "numero_contrato", message: "Número de contrato repetido dentro do próprio arquivo." }); if (!customerByDocument.has(row.customerDocument)) issues.push({ line, field: "documento_associado", message: "Associado não encontrado; importe os associados antes dos contratos." }); if (existingNumbers.has(row.number)) issues.push({ line, field: "numero_contrato", message: "Este contrato já existe no sistema." }); if (row.sellerEmail && (!userByEmail.has(row.sellerEmail) || !["admin", "seller"].includes(userByEmail.get(row.sellerEmail)?.role ?? ""))) issues.push({ line, field: "email_vendedor", message: "Vendedor interno não encontrado por e-mail ou possui papel incompatível." }); if (row.resortName && !resortRowsByName.has(row.resortName.trim().toLocaleLowerCase("pt-BR"))) issues.push({ line, field: "empreendimento", message: "Empreendimento não encontrado; importe o inventário (unidades) antes dos contratos." }); });
    if (issues.length) return { valid: false, committed: false, totalRows: rows.length, created: 0, updated: 0, issues: issues.slice(0, 100), sample: [], summary: importSummary(rows.length, 0, 0, issues) };
    let created = 0; let batchId = 0;
    await checkDuplicate();
    await db.transaction(async tx => { const createdBatch = await tx.insert(csvImportBatches).values({ kind: "contracts", actorUserId: ctx.user.id, totalRows: rows.length, ...origin }).$returningId(); batchId = createdBatch[0]?.id ?? 0; if (!batchId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível abrir o lote de importação." }); for (let index = 0; index < rows.length; index += 1) { const row = rows[index]!; const customer = customerByDocument.get(row.customerDocument)!; const seller = row.sellerEmail ? userByEmail.get(row.sellerEmail) : undefined; const createdContract = await tx.insert(contracts).values({ number: row.number, customerId: customer.id, sellerId: seller?.id ?? ctx.user.id, resortId: row.resortName ? resortRowsByName.get(row.resortName.trim().toLocaleLowerCase("pt-BR")) ?? null : null, usageModel: row.usageModel, status: row.status, totalAmount: row.totalAmount.toFixed(2), activatedAt: row.status === "active" ? new Date() : null, notes: row.notes }).$returningId(); const contractId = createdContract[0]?.id; if (!contractId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o contrato importado." }); const schedule = buildInstallmentSchedule(row.totalAmount, row.installmentCount, row.firstDueDate); await tx.insert(installments).values(schedule.map(item => ({ contractId, sequence: item.sequence, dueDate: item.dueDate, amount: item.amount, status: "open" as const }))); await recordInstallmentsScheduled(tx, { contractId, actorUserId: ctx.user.id }); await tx.insert(csvImportItems).values({ batchId, entityType: "contract", entityId: contractId, action: "created", ...provenance(index, row.number, row) }); created += 1; } await tx.update(csvImportBatches).set({ createdCount: created, updatedCount: 0, rejectedCount: 0 }).where(eq(csvImportBatches.id, batchId)); });
    await recordAudit(ctx.user.id, "csv_import", batchId, "completed", `Lote ${batchId}: ${created} contratos criados.${originNote()}`);
    return { valid: true, committed: true, batchId, totalRows: rows.length, created, updated: 0, issues: [] as ImportIssue[], sample: [], summary: importSummary(rows.length, created, 0, []), contentHash, duplicateOfBatchId };
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
          const [dependencies, portalLinks] = await Promise.all([
            tx.select({ id: contracts.id }).from(contracts).where(inArray(contracts.customerId, createdIds)),
            tx.select({ id: ownerPortalLinks.id }).from(ownerPortalLinks).where(inArray(ownerPortalLinks.customerId, createdIds)),
          ]);
          if (dependencies.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não dá para desfazer: associado importado já possui contrato vinculado." });
          if (portalLinks.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não dá para desfazer: associado importado já recebeu link do portal do associado." });
          // Contatos, documentos, interações e outros vínculos criados depois do lote também seguram o associado.
          try { await tx.delete(customers).where(inArray(customers.id, createdIds)); } catch (error) {
            if (isForeignKeyBlockError(error)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não dá para desfazer: associado importado já tem contato, documento, interação ou outro registro vinculado." });
            throw error;
          }
        }
        for (const item of items.filter(item => item.entityType === "customer" && item.action === "updated" && item.beforeSnapshot)) {
          // Cliente anonimizado depois da importação nunca volta ao estado de antes (o snapshot com dado pessoal foi limpo na anonimização).
          const [current] = await tx.select({ anonymizedAt: customers.anonymizedAt }).from(customers).where(eq(customers.id, item.entityId)).limit(1).for("update");
          if (current?.anonymizedAt) continue;
          const restored = restoreCustomerValues(JSON.parse(item.beforeSnapshot!) as Record<string, unknown>);
          await tx.update(customers).set(restored).where(eq(customers.id, item.entityId));
          await syncPrimaryContacts(tx, item.entityId, restored, ctx.user.id);
        }
      } else {
        const contractIds = items.filter(item => item.entityType === "contract" && item.action === "created").map(item => item.entityId);
        if (contractIds.length) {
          const installmentRows = await tx.select({ id: installments.id }).from(installments).where(inArray(installments.contractId, contractIds));
          const installmentIds = installmentRows.map(item => item.id);
          const [docs, bookings, taskRows, financial, billings, entitlements, waitlistRows, renegotiations, portfolioAssignments, transfers, commissions, revenueLedger, saleValidationRows, saleValidationTrail] = await Promise.all([
            tx.select({ id: contractDocuments.id }).from(contractDocuments).where(inArray(contractDocuments.contractId, contractIds)),
            tx.select({ id: reservations.id }).from(reservations).where(inArray(reservations.contractId, contractIds)),
            tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.contractId, contractIds)),
            tx.select({ id: financialTransactions.id }).from(financialTransactions).where(inArray(financialTransactions.contractId, contractIds)),
            installmentIds.length ? tx.select({ id: billingRecords.id }).from(billingRecords).where(inArray(billingRecords.installmentId, installmentIds)) : Promise.resolve([]),
            tx.select({ id: ownershipEntitlements.id }).from(ownershipEntitlements).where(inArray(ownershipEntitlements.contractId, contractIds)),
            tx.select({ id: reservationWaitlist.id }).from(reservationWaitlist).where(inArray(reservationWaitlist.contractId, contractIds)),
            tx.select({ id: installmentRenegotiations.id }).from(installmentRenegotiations).where(inArray(installmentRenegotiations.contractId, contractIds)),
            tx.select({ id: financialPortfolioAssignments.id }).from(financialPortfolioAssignments).where(inArray(financialPortfolioAssignments.contractId, contractIds)),
            tx.select({ id: financialTransfers.id }).from(financialTransfers).where(inArray(financialTransfers.contractId, contractIds)),
            tx.select({ id: salesCommissions.id }).from(salesCommissions).where(inArray(salesCommissions.contractId, contractIds)),
            tx.select({ id: revenueQualityLedger.id }).from(revenueQualityLedger).where(inArray(revenueQualityLedger.contractId, contractIds)),
            tx.select({ id: saleValidations.id }).from(saleValidations).where(inArray(saleValidations.contractId, contractIds)),
            tx.select({ id: saleValidationEvents.id }).from(saleValidationEvents).where(inArray(saleValidationEvents.contractId, contractIds)),
          ]);
          // ADR-007: validação da venda e sua trilha append-only nunca são apagadas; sem esta checagem o DELETE do contrato viraria erro de FK (500).
          if (saleValidationRows.length || saleValidationTrail.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não dá para desfazer: um contrato importado já tem validação de venda ou trilha de validação registrada (a trilha é imutável)." });
          if (docs.length || bookings.length || taskRows.length || financial.length || billings.length || entitlements.length || waitlistRows.length || renegotiations.length || portfolioAssignments.length || transfers.length || commissions.length || revenueLedger.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não dá para desfazer: o contrato importado já possui documentos, reserva, tarefa, cobrança, lançamento, direito, fila, renegociação, carteira, repasse, comissão ou ledger vinculado." });
          // PKG-FIN-03: o contrato some do CRM, então o Financial precisa cancelar os "a receber" já avisados (e os ainda na fila).
          for (const contractId of contractIds) await txEvent(tx, { eventName: "contract.status.updated", aggregateType: "contract", aggregateId: contractId, actorUserId: ctx.user.id, payload: { status: "cancelled", cancellationReason: "Importação desfeita" }, idempotencyKey: `import-undo:${batch.id}:${contractId}` });
          await tx.delete(installments).where(inArray(installments.contractId, contractIds));
          await tx.delete(contracts).where(inArray(contracts.id, contractIds));
        }
      }

      const batchUpdate = await tx.update(csvImportBatches).set({ status: "reverted", revertedAt: new Date(), revertedByUserId: ctx.user.id }).where(and(eq(csvImportBatches.id, batch.id), eq(csvImportBatches.status, "completed")));
      if (affectedRows(batchUpdate) === 0) throw new TRPCError({ code: "CONFLICT", message: "O lote foi alterado por outra operação. Recarregue e tente novamente." });
      return { batchId: batch.id, revertedItems: items.length, kind: batch.kind };
    });
    await recordAudit(ctx.user.id, "csv_import", outcome.batchId, "reverted", `Lote ${outcome.batchId} revertido com ${outcome.revertedItems} item(ns) auditado(s).`);
    return outcome;
  })
});
