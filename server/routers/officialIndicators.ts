import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, captureSheetSettings, commercialFractions, contracts, officialIndicatorVersions, saleValidations } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { txAudit } from "../txOutbox";
import { isIndicatorCode, OFFICIAL_INDICATOR_CODES, resolveIndicatorCatalog } from "../officialIndicatorCatalog";
import { classifyAttendances, computeOfficialIndicators, INCLUDE_IN_PROGRESS_KEY, OFFICIAL_INDICATORS_DEFINITION_VERSION, type AttendanceFact } from "../officialIndicators";
import { withDeadlockRetry } from "../mysqlErrors";
import { ENV } from "../_core/env";
import { addCalendarDays, localDayStart } from "../captureSheetDomain";
import { localDateInTimezone } from "../saleTermsPolicy";
import { adminProcedure, financeProcedure } from "./access";

const MAX_ROWS = 20_000;
/** Data real AAAA-MM-DD: 2026-02-31 não vale (o JS a empurraria para 3 de março). */
export const realDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const d = new Date(`${value}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value; }, "Data inexistente.");
const range = z.object({ from: realDay, to: realDay, resortId: z.number().int().positive().optional() });

async function requireDb() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); return db; }
async function includeInProgress(db: Awaited<ReturnType<typeof requireDb>>) {
  const [row] = await db.select().from(captureSheetSettings).where(eq(captureSheetSettings.key, INCLUDE_IN_PROGRESS_KEY)).limit(1);
  return row?.value === "1";
}

function requireCatalogFlag() {
  if (!ENV.officialIndicatorCatalogEnabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Catálogo de indicadores desligado (OFFICIAL_INDICATOR_CATALOG_ENABLED)." });
}

export const officialIndicatorsRouter = router({
  // Item 10: lista editável e versionada (só admin; desligada por padrão; não altera o cálculo nem a bridge do Relationship).
  catalog: adminProcedure.query(async () => {
    requireCatalogFlag();
    const db = await requireDb();
    return resolveIndicatorCatalog(await db.select().from(officialIndicatorVersions));
  }),
  catalogHistory: adminProcedure.input(z.object({ code: z.enum(OFFICIAL_INDICATOR_CODES) })).query(async ({ input }) => {
    requireCatalogFlag();
    const db = await requireDb();
    return db.select().from(officialIndicatorVersions).where(eq(officialIndicatorVersions.code, input.code)).orderBy(desc(officialIndicatorVersions.version)).limit(200);
  }),
  saveCatalogEntry: adminProcedure.input(z.object({ code: z.enum(OFFICIAL_INDICATOR_CODES), label: z.string().trim().min(3).max(160), description: z.string().trim().max(500).default(""), active: z.boolean() })).mutation(async ({ ctx, input }) => {
    requireCatalogFlag();
    if (!isIndicatorCode(input.code)) throw new TRPCError({ code: "BAD_REQUEST", message: "Indicador desconhecido." });
    const db = await requireDb();
    return withDeadlockRetry(() => db.transaction(async tx => {
      // Serializa a nova versão por código: o maior número vigente é lido com lock, a unique (code, version) é a rede.
      const [last] = await tx.select({ version: officialIndicatorVersions.version }).from(officialIndicatorVersions).where(eq(officialIndicatorVersions.code, input.code)).orderBy(desc(officialIndicatorVersions.version)).limit(1).for("update");
      const version = (last?.version ?? 0) + 1;
      await tx.insert(officialIndicatorVersions).values({ code: input.code, version, label: input.label, description: input.description, active: input.active, createdByUserId: ctx.user.id });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "official_indicator", entityId: input.code, action: "catalog_version_saved", summary: `Indicador ${input.code}: versão ${version} (${input.active ? "ativo" : "oculto"}).` });
      return { code: input.code, version };
    }));
  }),
  config: financeProcedure.query(async () => {
    const db = await requireDb();
    return { includeInProgress: await includeInProgress(db), definitionVersion: OFFICIAL_INDICATORS_DEFINITION_VERSION, provisional: true };
  }),
  setConfig: adminProcedure.input(z.object({ includeInProgress: z.boolean() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    await db.transaction(async tx => {
      const value = input.includeInProgress ? "1" : "0";
      await tx.insert(captureSheetSettings).values({ key: INCLUDE_IN_PROGRESS_KEY, value, provisional: true, updatedByUserId: ctx.user.id }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: ctx.user.id } });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "official_indicators", entityId: 0, action: "config_changed", summary: `Atendimento em andamento ${input.includeInProgress ? "ENTRA" : "fica FORA"} do denominador dos indicadores oficiais (provisório).` });
    });
    return { includeInProgress: input.includeInProgress };
  }),
  get: financeProcedure.input(range).query(async ({ input }) => {
    const db = await requireDb();
    // Dia civil no fuso do projeto (como o relatório da ficha), não em UTC.
    const tz = ENV.financialProjectTimezone.trim() || "America/Recife";
    const from = localDayStart(input.from, tz, localDateInTimezone);
    const to = localDayStart(addCalendarDays(input.to, 1), tz, localDateInTimezone);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new TRPCError({ code: "BAD_REQUEST", message: "Período inválido." });
    const withInProgress = await includeInProgress(db);

    const captureRows = await db.select({
      id: captureRecords.id, customerId: captureRecords.customerId, checkedInAt: captureRecords.checkedInAt, presentationStatus: captureRecords.presentationStatus,
      commercialOutcome: captureRecords.commercialOutcome, ntKind: captureRecords.ntKind,
    }).from(captureRecords).where(and(isNotNull(captureRecords.checkedInAt), gte(captureRecords.checkedInAt, from), lt(captureRecords.checkedInAt, to), input.resortId ? eq(captureRecords.resortId, input.resortId) : undefined)).limit(MAX_ROWS + 1);
    if (captureRows.length > MAX_ROWS) throw new TRPCError({ code: "BAD_REQUEST", message: "Período grande demais; reduza o intervalo." });
    // Casal com venda validada do CRM (mesmo associado, validada a partir do check-in) tem desfecho, mesmo sem resultado de sala gravado.
    const customerIds = Array.from(new Set(captureRows.map(row => row.customerId)));
    const saleRows = customerIds.length ? await db.select({ customerId: contracts.customerId, validatedAt: saleValidations.validatedAt }).from(saleValidations)
      .innerJoin(contracts, eq(contracts.id, saleValidations.contractId))
      .where(and(inArray(contracts.customerId, customerIds), isNotNull(saleValidations.validatedAt), ne(contracts.status, "cancelled"))) : [];
    const validatedAtByCustomer = new Map<number, Date[]>();
    for (const row of saleRows) if (row.validatedAt) validatedAtByCustomer.set(row.customerId, [...(validatedAtByCustomer.get(row.customerId) ?? []), row.validatedAt]);
    const facts: AttendanceFact[] = captureRows.map(row => ({
      checkedInAt: row.checkedInAt, presentationStatus: row.presentationStatus, commercialOutcome: row.commercialOutcome, ntKind: row.ntKind,
      hasValidatedSale: Boolean(row.checkedInAt && (validatedAtByCustomer.get(row.customerId) ?? []).some(at => at >= row.checkedInAt!)),
    }));
    const attendance = classifyAttendances(facts, from, to, withInProgress);

    // Numeradores: só fatos do CRM. Venda validada no período, contrato não cancelado; cota = fração cujo contrato atual é o da venda (mínimo 1 por venda).
    const validated = await db.select({ contractId: saleValidations.contractId }).from(saleValidations)
      .innerJoin(contracts, eq(contracts.id, saleValidations.contractId))
      .where(and(isNotNull(saleValidations.validatedAt), gte(saleValidations.validatedAt, from), lt(saleValidations.validatedAt, to), ne(contracts.status, "cancelled"), input.resortId ? eq(contracts.resortId, input.resortId) : undefined)).limit(MAX_ROWS + 1);
    if (validated.length > MAX_ROWS) throw new TRPCError({ code: "BAD_REQUEST", message: "Período grande demais; reduza o intervalo." });
    const contractIds = Array.from(new Set(validated.map(row => row.contractId)));
    let soldQuotas = 0;
    if (contractIds.length) {
      const fractionCounts = await db.select({ contractId: commercialFractions.currentContractId, quotas: sql<number>`COUNT(*)` }).from(commercialFractions)
        .where(and(inArray(commercialFractions.currentContractId, contractIds), eq(commercialFractions.status, "sold"))).groupBy(commercialFractions.currentContractId);
      const byContract = new Map(fractionCounts.map(row => [row.contractId, Number(row.quotas)]));
      soldQuotas = contractIds.reduce((sum, id) => sum + Math.max(1, byContract.get(id) ?? 0), 0);
    }
    return {
      ...computeOfficialIndicators({ attendances: attendance.attendances, validatedSales: contractIds.length, soldQuotas }),
      definitionVersion: OFFICIAL_INDICATORS_DEFINITION_VERSION, provisional: true,
      denominator: { definition: "casal com check-in da recepção no período e desfecho registrado (resultado comercial, não tour ou ficha encerrada)", includeInProgress: withInProgress, inProgressExcluded: attendance.inProgressExcluded, inProgressTotal: attendance.inProgressTotal },
      numerator: { definition: "venda validada pelo CRM (sale_validations.validatedAt) no período, contrato não cancelado; cota = fração vendida do contrato (mínimo 1 por venda)", manualWonIgnored: true },
      range: { from: input.from, to: input.to },
    };
  }),
});
