import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import {
  billingRecords,
  captureRecords,
  commercialFractions,
  commercialPolicyVersions,
  contractMonetaryAdjustments,
  contracts,
  installments,
  monetaryIndexValues,
  opportunities,
  proposals,
} from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, financeProcedure } from "./access";
import { buildMonetaryAdjustment, parseMonetaryAdjustmentPolicy } from "../monetaryAdjustment";

const day = (value: Date | string) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const atNoon = (value: Date | string) => value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
const monthStart = (value: Date | string) => {
  const parsed = atNoon(value);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1, 12));
};

async function resolveContractResortId(db: any, contract: typeof contracts.$inferSelect) {
  const fractionRows = await db.select({ resortId: commercialFractions.resortId }).from(commercialFractions)
    .where(eq(commercialFractions.currentContractId, contract.id)).limit(2);
  const fractionResorts = Array.from(new Set(fractionRows.map((row: { resortId: number }) => row.resortId).filter(Boolean)));
  if (fractionResorts.length === 1) return fractionResorts[0];
  if (fractionResorts.length > 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "O contrato está ligado a cotas de mais de um empreendimento. Corrija o estoque antes do reajuste." });

  if (!contract.proposalId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Contrato sem empreendimento canônico. Vincule-o a uma proposta/cota antes do reajuste." });
  const captureRows = await db.select({ resortId: captureRecords.resortId }).from(proposals)
    .innerJoin(opportunities, eq(proposals.opportunityId, opportunities.id))
    .innerJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id))
    .where(eq(proposals.id, contract.proposalId))
    .limit(20);
  const captureResorts = Array.from(new Set(captureRows.map((row: { resortId: number | null }) => row.resortId).filter((value: number | null): value is number => Boolean(value))));
  if (captureResorts.length === 1) return captureResorts[0];
  if (!captureResorts.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não foi possível determinar o empreendimento do contrato. Não aplique política monetária sem escopo canônico." });
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "O histórico comercial aponta mais de um empreendimento para este contrato. Corrija o vínculo antes do reajuste." });
}

async function loadSimulation(db: any, input: { contractId: number; policyVersionId: number; throughDate: string }, lock = false) {
  const contractQuery = db.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1);
  const contract = (lock ? await contractQuery.for("update") : await contractQuery)[0];
  if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });

  const policy = (await db.select().from(commercialPolicyVersions)
    .where(and(eq(commercialPolicyVersions.id, input.policyVersionId), eq(commercialPolicyVersions.policyType, "monetary_adjustment")))
    .limit(1))[0];
  if (!policy) throw new TRPCError({ code: "NOT_FOUND", message: "Política de reajuste não encontrada." });
  const contractResortId = await resolveContractResortId(db, contract);
  if (policy.resortId !== contractResortId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A política de reajuste pertence a outro empreendimento." });
  let parsedPolicy;
  try {
    parsedPolicy = parseMonetaryAdjustmentPolicy(policy.policyJson);
  } catch {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A política de reajuste está inválida. Revise a versão antes de aplicar." });
  }

  const latestQuery = db.select().from(contractMonetaryAdjustments)
    .where(eq(contractMonetaryAdjustments.contractId, input.contractId))
    .orderBy(desc(contractMonetaryAdjustments.throughDate)).limit(1);
  const latest = (lock ? await latestQuery.for("update") : await latestQuery)[0];

  const baseDate = atNoon(latest?.throughDate ?? contract.signedAt ?? contract.activatedAt ?? contract.createdAt);
  const throughDate = atNoon(input.throughDate);
  if (throughDate.getTime() <= baseDate.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "A data final precisa ser posterior à base do último reajuste." });

  const indexRows = await db.select().from(monetaryIndexValues)
    .where(and(
      eq(monetaryIndexValues.indexCode, parsedPolicy.indexCode),
      gt(monetaryIndexValues.referenceDate, monthStart(baseDate)),
      lte(monetaryIndexValues.referenceDate, monthStart(throughDate)),
    )).orderBy(monetaryIndexValues.referenceDate).limit(120);

  const installmentQuery = db.select({ id: installments.id, amount: installments.amount, sequence: installments.sequence, status: installments.status })
    .from(installments)
    .where(and(eq(installments.contractId, input.contractId), inArray(installments.status, ["open", "overdue"])))
    .orderBy(installments.sequence);
  const adjustable = lock ? await installmentQuery.for("update") : await installmentQuery;
  if (!adjustable.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "O contrato não possui parcelas abertas para reajuste." });

  const activeBillings = await db.select({
    id: billingRecords.id,
    installmentId: billingRecords.installmentId,
    status: billingRecords.status,
    gatewayProvider: billingRecords.gatewayProvider,
    gatewayPaymentId: billingRecords.gatewayPaymentId,
    amount: billingRecords.amount,
  }).from(billingRecords).where(and(
    inArray(billingRecords.installmentId, adjustable.map((item: { id: number }) => item.id)),
    inArray(billingRecords.status, ["pending", "generated"]),
  )).limit(500);

  const calculation = buildMonetaryAdjustment({
    policy: parsedPolicy,
    baseDate,
    throughDate,
    indexValues: indexRows,
    installments: adjustable,
  });
  return { contract, contractResortId, policy, parsedPolicy, baseDate, throughDate, indexRows, adjustable, activeBillings, calculation };
}

export const monetaryAdjustmentsRouter = router({
  indexValues: financeProcedure.input(z.object({
    indexCode: z.string().trim().min(1).max(40),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.number().int().min(1).max(240).default(120),
  })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(monetaryIndexValues).where(and(
      eq(monetaryIndexValues.indexCode, input.indexCode),
      input.from ? gt(monetaryIndexValues.referenceDate, atNoon(input.from)) : undefined,
      input.to ? lte(monetaryIndexValues.referenceDate, atNoon(input.to)) : undefined,
    )).orderBy(desc(monetaryIndexValues.referenceDate)).limit(input.limit);
  }),

  upsertIndexValue: adminProcedure.input(z.object({
    indexCode: z.string().trim().min(1).max(40),
    referenceDate: z.string().date(),
    variationPercent: z.coerce.number().min(-99).max(1000),
    source: z.string().trim().min(2).max(255),
    sourceReference: z.string().trim().max(500).optional().nullable(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.insert(monetaryIndexValues).values({
      indexCode: input.indexCode.toUpperCase(),
      referenceDate: monthStart(input.referenceDate),
      variationPercent: input.variationPercent.toFixed(6),
      source: input.source,
      sourceReference: input.sourceReference?.trim() || null,
      importedByUserId: ctx.user.id,
    }).onDuplicateKeyUpdate({ set: {
      variationPercent: input.variationPercent.toFixed(6),
      source: input.source,
      sourceReference: input.sourceReference?.trim() || null,
      importedByUserId: ctx.user.id,
    } });
    await recordAudit(ctx.user.id, "monetary_index_value", `${input.indexCode.toUpperCase()}:${input.referenceDate}`, "upserted", `Índice ${input.indexCode.toUpperCase()} em ${input.referenceDate}: ${input.variationPercent}%.`);
    return { success: true };
  }),

  simulate: financeProcedure.input(z.object({
    contractId: z.number().int().positive(),
    policyVersionId: z.number().int().positive(),
    throughDate: z.string().date(),
  })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const prepared = await loadSimulation(db, input);
    return {
      contractId: input.contractId,
      policyVersionId: input.policyVersionId,
      policyVersion: prepared.policy.version,
      baseDate: day(prepared.baseDate),
      throughDate: day(prepared.throughDate),
      activeBillings: prepared.activeBillings,
      calculation: prepared.calculation,
    };
  }),

  applyAdjustment: financeProcedure.input(z.object({
    contractId: z.number().int().positive(),
    policyVersionId: z.number().int().positive(),
    throughDate: z.string().date(),
    confirmation: z.literal("APPLY_REVIEWED_ADJUSTMENT"),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const result = await db.transaction(async tx => {
      const prepared = await loadSimulation(tx, input, true);
      if (!prepared.calculation.eligible) {
        const reason = prepared.calculation.reason === "index_series_incomplete"
          ? `Série ${prepared.calculation.indexCode} incompleta. Meses ausentes: ${prepared.calculation.missingMonths.join(", ") || "nenhum"}; duplicados: ${prepared.calculation.duplicateMonths.join(", ") || "nenhum"}.`
          : `Periodicidade ainda não atingida: ${prepared.calculation.elapsedMonths}/${prepared.calculation.requiredMonths} meses.`;
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: reason });
      }
      if (prepared.activeBillings.length) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Existem ${prepared.activeBillings.length} cobranças ativas para parcelas que seriam reajustadas. Cancele/reconcilie as cobranças antes de alterar o saldo.` });
      }
      const calculation = prepared.calculation;
      for (const item of calculation.installments) {
        const update = await tx.update(installments).set({ amount: item.after.toFixed(2) })
          .where(and(eq(installments.id, item.id), inArray(installments.status, ["open", "overdue"])));
        if (update && typeof update === "object" && "affectedRows" in update && Number(update.affectedRows) !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: `A parcela #${item.id} mudou durante o reajuste. Nenhuma alteração foi aplicada.` });
        }
      }
      let created;
      try {
        created = await tx.insert(contractMonetaryAdjustments).values({
          contractId: input.contractId,
          policyVersionId: input.policyVersionId,
          indexCode: prepared.parsedPolicy.indexCode,
          baseDate: prepared.baseDate,
          throughDate: prepared.throughDate,
          periodicityMonths: prepared.parsedPolicy.periodicityMonths,
          spreadMonthlyPercent: prepared.parsedPolicy.spreadMonthlyPercent.toFixed(4),
          indexFactor: calculation.indexFactor.toFixed(10),
          spreadFactor: calculation.spreadFactor.toFixed(10),
          totalFactor: calculation.totalFactor.toFixed(10),
          beforeTotal: calculation.beforeTotal.toFixed(2),
          afterTotal: calculation.afterTotal.toFixed(2),
          calculationJson: JSON.stringify(calculation),
          appliedByUserId: ctx.user.id,
        }).$returningId();
      } catch (error) {
        if (error && typeof error === "object" && ("code" in error || "errno" in error)) {
          const candidate = error as { code?: unknown; errno?: unknown };
          if (candidate.code === "ER_DUP_ENTRY" || Number(candidate.errno) === 1062) throw new TRPCError({ code: "CONFLICT", message: "Este contrato já foi reajustado para a data informada." });
        }
        throw error;
      }
      const adjustmentId = created[0]?.id;
      if (!adjustmentId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar a memória de cálculo do reajuste." });
      return { adjustmentId, calculation, baseDate: day(prepared.baseDate), policyVersion: prepared.policy.version };
    });
    await recordAudit(ctx.user.id, "contract_monetary_adjustment", result.adjustmentId, "applied", `Contrato #${input.contractId} reajustado até ${input.throughDate}; fator ${result.calculation.totalFactor}; antes ${result.calculation.beforeTotal.toFixed(2)}; depois ${result.calculation.afterTotal.toFixed(2)}.`);
    await recordDomainEvent({ eventName: "contract.monetary_adjustment.applied", aggregateType: "contract", aggregateId: input.contractId, actorUserId: ctx.user.id, payload: { adjustmentId: result.adjustmentId, contractId: input.contractId, policyVersionId: input.policyVersionId, policyVersion: result.policyVersion, baseDate: result.baseDate, throughDate: input.throughDate, indexCode: result.calculation.indexCode, totalFactor: result.calculation.totalFactor, beforeTotal: result.calculation.beforeTotal, afterTotal: result.calculation.afterTotal } });
    return result;
  }),

  history: financeProcedure.input(z.object({ contractId: z.number().int().positive(), limit: z.number().int().min(1).max(100).default(50) })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(contractMonetaryAdjustments)
      .where(eq(contractMonetaryAdjustments.contractId, input.contractId))
      .orderBy(desc(contractMonetaryAdjustments.createdAt))
      .limit(input.limit);
  }),
});
