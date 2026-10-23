import { createHash, timingSafeEqual } from "node:crypto";
import { fixContractCommissionRoleMapAtFormalization } from "./commissionRoleMapSnapshot";
import { resolveResortForProject, ResortResolutionError } from "./resortResolution";
import { eligibilityHook } from "./nonBuyerEligibilityService";
import { recordInstallmentsScheduled } from "./installmentScheduledFacts";
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  commercialFractionHistory,
  commercialFractions,
  commercialPolicyVersions,
  captureRecords,
  contracts,
  customers,
  domainEvents,
  financialTransactions,
  installments,
  opportunities,
  proposals,
  resorts,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  addDays,
  buildBalanceSchedule,
  localDateInTimezone,
  parseSaleTermsPolicy,
} from "./saleTermsPolicy";
import { holdFractionForFormalization, isInventoryHoldAtFormalizationEnabled } from "./formalizationInventory";
import { syncRevenueQualityForContract } from "./revenueQualitySync";
import { affectedRows, isDuplicateKeyError, withDeadlockRetry } from "./mysqlErrors";
import { logger } from "./logger";
import { isCoupleCode, normalizeCoupleCode } from "./captureSheetDomain";

// PIL-008: recusa de DOMÍNIO (não vale a pena o Sales reenviar) vs falha de INFRAESTRUTURA (transitória, 503).
// O Sales lê o código, para de tentar e deixa a venda visível para revisão (PRD v4, resposta 7: REJECTED_BY_CRM com motivo).
export const SALES_INGEST_REJECTION_CODES = [
  "INSUFFICIENT_INVENTORY", "SALE_TERMS_POLICY_MISSING", "SALE_TERMS_POLICY_AMBIGUOUS",
  "PROJECT_NOT_MAPPED", "PROJECT_MAPPING_CONFLICT", "INVALID_COMMERCIAL_SNAPSHOT", "INSTALLMENT_LIMIT_EXCEEDED",
] as const;
/**
 * CRM-E1: 422 de replay quando a reserva da cota venceu. Fica FORA de SALES_INGEST_REJECTION_CODES (lista do snapshot do contrato compartilhado) até a Suite #130
 * ser mergeada: o PR de re-pin move este código para a lista e atualiza snapshot + consumers.lock.json (ordem Suite -> CRM -> re-pin).
 */
export const INVENTORY_HELD_EXPIRED_CODE = "INVENTORY_HELD_EXPIRED" as const;
export type SalesIngestRejectionCode = (typeof SALES_INGEST_REJECTION_CODES)[number];
export class SalesIngestRejection extends Error {
  constructor(readonly code: SalesIngestRejectionCode, message: string) { super(message); this.name = "SalesIngestRejection"; }
}
// Corpo da resposta do ingest quando a venda NÃO é aceita (rota e export do contrato usam esta função).
export function salesIngestFailureBody(mapped: { status: 422 | 503; code: string }, error: unknown) {
  return { accepted: false as const, code: mapped.code, error: mapped.status === 422 && error instanceof Error ? error.message : "Event processing failed" };
}

export function mapSalesIngestError(error: unknown): { status: 422 | 503; code: string } {
  if (error instanceof SalesIngestRejection) return { status: 422, code: error.code };
  return { status: 503, code: "EVENT_PROCESSING_FAILED" };
}

const entryScheduleRow = z.strictObject({
  sequence: z.number().int().min(1).max(100),
  amountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isStrictCalendarDate, "Invalid calendar date"),
});

export const salesCommandSaleSchema = z.strictObject({
  eventId: z.string().trim().min(1).max(120),
  eventName: z.literal("sale.ready_for_contract.v1"),
  source: z.literal("sales-command"),
  correlationId: z.string().trim().min(1).max(120),
  occurredAt: z.string().datetime(),
  project: z.strictObject({
    externalKey: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(160),
    timezone: z.string().trim().min(1).max(80).refine(isValidTimeZone, "Invalid IANA time zone"),
  }),
  saleId: z.string().trim().min(1).max(120),
  encounterId: z.string().trim().min(1).max(120),
  // F1.10: código público do casal no Sales (CP-…). OPCIONAL: enquanto o Sales não o emitir, o corpo é o de sempre. Quando vier, a ficha nasce (ou é reaproveitada) com ele.
  coupleCode: z.string().trim().min(1).max(64).optional(),
  customer: z.strictObject({
    name: z.string().trim().min(2).max(255),
    phone: z.string().trim().max(32).optional(),
  }),
  sale: z.strictObject({
    quotasCount: z.number().int().min(1).max(104),
    vgvCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    entryContractedCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    // CRM-H1: recebimento DECLARADO pelo Sales (comprovante), não dinheiro conferido. `entryReceiptClaimedCents` é o nome novo; `entryReceivedCents` segue aceito.
    entryReceivedCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    entryReceiptClaimedCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    entryInstallmentCount: z.number().int().min(1).max(100),
    entrySchedule: z.array(entryScheduleRow).min(1).max(100),
    firstBalanceDueInDays: z.number().int().min(0).max(365),
    paymentMethods: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  }).superRefine((sale, ctx) => {
    if (sale.entryReceivedCents === undefined && sale.entryReceiptClaimedCents === undefined) ctx.addIssue({ code: "custom", path: ["entryReceiptClaimedCents"], message: "Informe entryReceiptClaimedCents (ou entryReceivedCents)." });
    if (sale.entryReceivedCents !== undefined && sale.entryReceiptClaimedCents !== undefined && sale.entryReceivedCents !== sale.entryReceiptClaimedCents) ctx.addIssue({ code: "custom", path: ["entryReceiptClaimedCents"], message: "entryReceivedCents e entryReceiptClaimedCents divergem." });
  }).transform(({ entryReceiptClaimedCents, entryReceivedCents, ...rest }) => ({ ...rest, entryReceivedCents: (entryReceivedCents ?? entryReceiptClaimedCents)! })),
});

export type SalesCommandSale = z.infer<typeof salesCommandSaleSchema>;

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function money(cents: number) {
  return (cents / 100).toFixed(2);
}

function salesCommandReference(saleId: string) {
  return `SC-${createHash("sha256").update(saleId).digest("hex").slice(0, 48)}`;
}

function salesCommandEntryIdempotencyKey(saleId: string) {
  return `sc-entry:${createHash("sha256").update(saleId).digest("hex")}`;
}

function isStrictCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateValue(value: string) {
  if (!isStrictCalendarDate(value)) throw new SalesIngestRejection("INVALID_COMMERCIAL_SNAPSHOT", "Invalid calendar date");
  return new Date(`${value}T12:00:00Z`);
}

function validateCommercialSnapshot(event: SalesCommandSale) {
  const invalid = (message: string) => new SalesIngestRejection("INVALID_COMMERCIAL_SNAPSHOT", message);
  const ordered = [...event.sale.entrySchedule].sort((left, right) => left.sequence - right.sequence);
  if (ordered.length !== event.sale.entryInstallmentCount) throw invalid("Entry schedule count mismatch");
  if (ordered.some((row, index) => row.sequence !== index + 1)) throw invalid("Entry schedule must be contiguous");
  const entryTotal = ordered.reduce((sum, row) => sum + row.amountCents, 0);
  if (!Number.isSafeInteger(entryTotal) || entryTotal !== event.sale.entryContractedCents) throw invalid("Entry schedule total mismatch");
  if (event.sale.entryContractedCents > event.sale.vgvCents) throw invalid("Entry cannot exceed VGV");
  if (event.sale.entryReceivedCents > event.sale.entryContractedCents) throw invalid("Received entry cannot exceed contracted entry");
  return ordered;
}

async function findFormalization(db: any, saleId: string) {
  const contract = (await db.select().from(contracts).where(and(
    eq(contracts.externalSource, "sales-command"),
    eq(contracts.externalSaleId, saleId),
  )).limit(1))[0];
  if (!contract) return null;
  const proposal = contract.proposalId
    ? (await db.select().from(proposals).where(eq(proposals.id, contract.proposalId)).limit(1))[0]
    : null;
  const opportunity = proposal
    ? (await db.select().from(opportunities).where(eq(opportunities.id, proposal.opportunityId)).limit(1))[0]
    : null;
  if (!proposal || !opportunity) throw new Error("Sales Command lineage is incomplete");
  const fractionRows = await db.select({ id: commercialFractions.id }).from(commercialFractions)
    .where(eq(commercialFractions.currentContractId, contract.id)).orderBy(asc(commercialFractions.id)).limit(200);
  const installmentRows = await db.select({ id: installments.id }).from(installments)
    .where(eq(installments.contractId, contract.id)).orderBy(asc(installments.sequence)).limit(500);
  return {
    customerId: opportunity.customerId,
    opportunityId: opportunity.id,
    proposalId: proposal.id,
    contractId: contract.id,
    inventoryLostAt: (contract.inventoryLostAt as Date | null) ?? null,
    installmentCount: installmentRows.length,
    fractionIds: fractionRows.map((row: { id: number }) => row.id),
  };
}

// A regra de mapeamento vive em resortResolution.ts (compartilhada com o receptor de atendimento); aqui só traduz a falha para a rejeição da venda, com os mesmos códigos e textos.
async function resolveResort(tx: any, project: SalesCommandSale["project"]) {
  try { return await resolveResortForProject(tx, project); } catch (error) {
    if (error instanceof ResortResolutionError) throw new SalesIngestRejection(error.code, error.message);
    throw error;
  }
}

async function resolveSaleTerms(tx: any, resortId: number, occurredAt: Date) {
  const rows = await tx.select().from(commercialPolicyVersions).where(and(
    eq(commercialPolicyVersions.resortId, resortId),
    eq(commercialPolicyVersions.policyType, "sale_terms"),
    lte(commercialPolicyVersions.effectiveAt, occurredAt),
    or(isNull(commercialPolicyVersions.retiredAt), gt(commercialPolicyVersions.retiredAt, occurredAt)),
  )).orderBy(desc(commercialPolicyVersions.effectiveAt), desc(commercialPolicyVersions.id)).limit(2);
  const policy = rows[0];
  if (!policy) throw new SalesIngestRejection("SALE_TERMS_POLICY_MISSING", "Applicable sale_terms policy required at sale occurrence time");
  const sameEffective = rows[1] && rows[1].effectiveAt.getTime() === policy.effectiveAt.getTime();
  if (sameEffective) throw new SalesIngestRejection("SALE_TERMS_POLICY_AMBIGUOUS", "Ambiguous sale_terms policy effective date");
  return { row: policy, terms: parseSaleTermsPolicy(policy.policyJson) };
}

function allocateReceived(entrySchedule: SalesCommandSale["sale"]["entrySchedule"], receivedCents: number, occurredAt: Date, method: string | null) {
  let remaining = Math.min(receivedCents, entrySchedule.reduce((sum, row) => sum + row.amountCents, 0));
  return entrySchedule.map(row => {
    const paidCents = Math.min(row.amountCents, remaining);
    remaining -= paidCents;
    const fullyPaid = paidCents === row.amountCents;
    return {
      sequence: row.sequence,
      dueDate: dateValue(row.dueDate),
      amount: money(row.amountCents),
      paidAmount: money(paidCents),
      status: fullyPaid ? "paid" as const : "open" as const,
      paidAt: fullyPaid ? occurredAt : null,
      paymentMethod: paidCents > 0 ? method : null,
    };
  });
}

/**
 * F1.10: reaproveitar a ficha que a recepção já abriu para o MESMO casal (mesmo cliente, visita recente, sem oportunidade) em vez de criar uma segunda ficha "Sales Command".
 * DESLIGADO por padrão (SALE_BRIDGE_REUSE_CAPTURE_ENABLED): lido a cada chamada. O reaproveitamento por coupleCode (chave única) não depende da flag: sem ele a criação bateria na chave única.
 */
export const isSaleBridgeReuseCaptureEnabled = () => process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED === "true";
const SALE_BRIDGE_CAPTURE_LOCATION = "Sales Command";
/** Janela da visita: a ficha da recepção e a venda do mesmo casal acontecem no mesmo dia (folga para virada de dia e fuso). */
const RECEPTION_CAPTURE_WINDOW_MS = 36 * 3_600_000;

function usableCoupleCode(raw: string | undefined, saleId: string): string | null {
  if (!raw) return null;
  const code = normalizeCoupleCode(raw);
  if (isCoupleCode(code)) return code;
  // Código fora do formato da ficha (ex.: só dígitos, parece telefone): a venda segue sem ligar, e o motivo fica no log (sem o valor).
  logger.warn("Sales Command sale carried an unusable coupleCode; capture not linked by code", { saleId });
  return null;
}

type CaptureForLink = { id: number; customerId: number; resortId: number | null; coupleCode: string | null; opportunityId: number | null; anonymizedAt: Date | null };
const CLOSED_OPPORTUNITY_STAGES = ["won", "lost"];

/** Ficha existente ligada ao casal da venda: 1) pelo coupleCode (único); 2) com a flag, pela visita recente do mesmo cliente (sem oportunidade ou com oportunidade ainda aberta, que é o que a recepção cria por padrão). Nunca devolve ficha anonimizada. */
async function findCaptureForSale(tx: any, input: { coupleCode: string | null; customerId: number | null; occurredAt: Date; resortId: number }): Promise<{ link: { capture: CaptureForLink; by: "couple_code" | "reception_visit" } | null; codeFree: boolean }> {
  if (input.coupleCode) {
    const [byCode] = await tx.select().from(captureRecords).where(eq(captureRecords.coupleCode, input.coupleCode)).limit(1).for("update");
    // Código preso a uma ficha anonimizada: não reaproveita (dados apagados a pedido do titular) e também não pode ser gravado de novo (chave única): a ficha da venda nasce sem ele.
    // Ficha de OUTRO resort (mesmo código) também não é reaproveitada: o contrato e a política da venda são do resort resolvido; a ficha da venda nasce sem o código (chave única já ocupada).
    if (byCode) {
      const otherResort = byCode.resortId != null && byCode.resortId !== input.resortId;
      if (otherResort) logger.warn("Sales Command sale coupleCode belongs to a capture of another resort; capture not reused", { captureId: byCode.id });
      return { link: byCode.anonymizedAt || otherResort ? null : { capture: byCode, by: "couple_code" }, codeFree: false };
    }
  }
  const none = { link: null, codeFree: true };
  if (!isSaleBridgeReuseCaptureEnabled() || !input.customerId) return none;
  const since = new Date(input.occurredAt.getTime() - RECEPTION_CAPTURE_WINDOW_MS);
  const found = await tx.select().from(captureRecords).where(and(
    eq(captureRecords.customerId, input.customerId),
    isNull(captureRecords.anonymizedAt),
    // Só o resort da venda (ou ficha ainda sem resort, que a venda preenche): ficha de outro resort nunca é candidata.
    or(isNull(captureRecords.resortId), eq(captureRecords.resortId, input.resortId)),
    // Ficha sem local de captação (campo opcional na recepção) também vale: em SQL, NULL <> x não é verdadeiro.
    or(isNull(captureRecords.captureLocation), ne(captureRecords.captureLocation, SALE_BRIDGE_CAPTURE_LOCATION)),
    or(and(isNotNull(captureRecords.checkedInAt), gte(captureRecords.checkedInAt, since)), and(isNull(captureRecords.checkedInAt), gte(captureRecords.createdAt, since))),
  )).orderBy(desc(captureRecords.id)).limit(10).for("update");
  // A recepção cria a ficha com uma oportunidade "new" por padrão: serve a ficha sem oportunidade ou cuja oportunidade ainda está aberta (a venda a reaproveita). Oportunidade já fechada = ficha de outra negociação.
  const candidates: CaptureForLink[] = [];
  for (const row of found) {
    if (!row.opportunityId) { candidates.push(row); continue; }
    const [opp] = await tx.select({ stage: opportunities.stage }).from(opportunities).where(eq(opportunities.id, row.opportunityId)).limit(1);
    if (opp && !CLOSED_OPPORTUNITY_STAGES.includes(opp.stage)) candidates.push(row);
  }
  // Dois candidatos = ambíguo: não adivinha (criar a ficha da venda é o comportamento de sempre; a recepção resolve pelo alerta de ficha sem vínculo).
  return candidates.length === 1 ? { link: { capture: candidates[0]!, by: "reception_visit" }, codeFree: true } : none;
}

export async function materializeSalesCommandSale(tx: any, event: SalesCommandSale) {
  const existing = await findFormalization(tx, event.saleId);
  if (existing) return { ...existing, replay: true as const };

  const occurredAt = new Date(event.occurredAt);
  const entrySchedule = validateCommercialSnapshot(event);
  const resort = await resolveResort(tx, event.project);
  const { row: termsRow, terms } = await resolveSaleTerms(tx, resort.id, occurredAt);

  const coupleCode = usableCoupleCode(event.coupleCode, event.saleId);
  let customerId: number | undefined;
  if (event.customer.phone) {
    const [matched] = await tx.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.phone, event.customer.phone), eq(customers.fullName, event.customer.name))).limit(1);
    customerId = matched?.id;
  }
  // F1.10: a ficha do casal (quando existe) manda no cliente: a venda se junta a ela em vez de abrir um segundo cadastro.
  const { link: linked, codeFree } = await findCaptureForSale(tx, { coupleCode, customerId: customerId ?? null, occurredAt, resortId: resort.id });
  if (linked) customerId = linked.capture.customerId;
  if (!customerId) {
    const createdCustomer = await tx.insert(customers).values({
      fullName: event.customer.name,
      phone: event.customer.phone ?? null,
      acquisitionSource: "Sales Command",
      status: "active",
      notes: "Criado automaticamente pela formalização Sales Command → CRM.",
    }).$returningId();
    customerId = createdCustomer[0]?.id;
  }
  if (!customerId) throw new Error("Customer formalization failed");

  // A oportunidade que a recepção abriu para a ficha (stage "new") vira a venda ganha: reaproveitá-la mantém uma só oportunidade por casal e a ficha continua achando o contrato por captureRecords.opportunityId (revenueQualitySync, contratos, financeiro).
  let priorOpportunity: { id: number; customerId: number; stage: string } | null = null;
  if (linked?.capture.opportunityId) {
    const [prior] = await tx.select({ id: opportunities.id, customerId: opportunities.customerId, stage: opportunities.stage }).from(opportunities).where(eq(opportunities.id, linked.capture.opportunityId)).limit(1).for("update");
    priorOpportunity = prior ?? null;
  }
  const reusable = priorOpportunity && priorOpportunity.customerId === customerId && !CLOSED_OPPORTUNITY_STAGES.includes(priorOpportunity.stage) ? priorOpportunity : null;
  let opportunityId: number | undefined;
  if (reusable) {
    await tx.update(opportunities).set({
      title: "Venda Sales Command " + event.saleId.slice(0, 12),
      stage: "won",
      expectedAmount: money(event.sale.vgvCents),
      probability: 100,
      nextFollowUpAt: null,
      closedAt: occurredAt,
    }).where(eq(opportunities.id, reusable.id));
    opportunityId = reusable.id;
  } else {
    const opportunityRow = await tx.insert(opportunities).values({
      customerId,
      title: "Venda Sales Command " + event.saleId.slice(0, 12),
      stage: "won",
      source: "Sales Command",
      expectedAmount: money(event.sale.vgvCents),
      probability: 100,
      closedAt: occurredAt,
    }).$returningId();
    opportunityId = opportunityRow[0]?.id;
  }
  if (!opportunityId) throw new Error("Opportunity formalization failed");

  let captureLink: { captureId: number; by: "couple_code" | "reception_visit" | "created"; codeWritten: boolean } | null = null;
  if (linked) {
    // Ficha da recepção: aponta para a oportunidade da venda e, se faltava, ganha o código do casal e o resort. Estado da sala (check-in, tour, resultado) NÃO é tocado.
    const patch: { opportunityId?: number; coupleCode?: string; resortId?: number } = {};
    // Oportunidade anterior ganha (de outra venda) não é roubada: fica o ponteiro e o alerta abaixo.
    if (priorOpportunity?.stage === "won" && priorOpportunity.id !== opportunityId) {
      logger.warn("Sales Command sale linked to a capture whose opportunity is already won; capture opportunity kept", { saleId: event.saleId, captureId: linked.capture.id });
    } else if (linked.capture.opportunityId !== opportunityId) patch.opportunityId = opportunityId;
    if (!linked.capture.coupleCode && coupleCode) patch.coupleCode = coupleCode;
    if (linked.capture.resortId == null) patch.resortId = resort.id;
    if (Object.keys(patch).length) {
      try { await tx.update(captureRecords).set(patch).where(eq(captureRecords.id, linked.capture.id)); }
      catch (error) {
        // Corrida: outro processo ligou este código a outra ficha entre a leitura e a escrita. Sem o código, a venda segue (o alerta de ficha sem vínculo cobre).
        if (!(isDuplicateKeyError(error) && patch.coupleCode)) throw error;
        delete patch.coupleCode;
        if (Object.keys(patch).length) await tx.update(captureRecords).set(patch).where(eq(captureRecords.id, linked.capture.id));
      }
    }
    captureLink = { captureId: linked.capture.id, by: linked.by, codeWritten: Boolean(patch.coupleCode) };
  } else {
    const [createdCapture] = await tx.insert(captureRecords).values({
      customerId,
      resortId: resort.id,
      opportunityId,
      coupleCode: codeFree ? coupleCode : null,
      captureLocation: SALE_BRIDGE_CAPTURE_LOCATION,
      presentationStatus: "closed",
      qualificationStatus: "qualified",
      notes: `Formalização automática da venda ${event.saleId}.`,
    }).$returningId();
    captureLink = { captureId: createdCapture!.id, by: "created", codeWritten: codeFree && Boolean(coupleCode) };
  }

  const balanceCents = event.sale.vgvCents - event.sale.entryContractedCents;
  const balanceCount = balanceCents > 0 ? terms.balanceInstallmentCount : 0;
  const totalInstallments = entrySchedule.length + balanceCount;
  if (totalInstallments > 360) throw new SalesIngestRejection("INSTALLMENT_LIMIT_EXCEEDED", "Combined contract installment schedule exceeds supported limit of 360");
  const proposalRow = await tx.insert(proposals).values({
    opportunityId,
    reference: salesCommandReference(event.saleId),
    productDescription: `${event.project.name} · ${event.sale.quotasCount} cota(s)`,
    totalAmount: money(event.sale.vgvCents),
    downPaymentAmount: money(event.sale.entryContractedCents),
    installmentCount: Math.max(1, totalInstallments),
    status: "approved",
  }).$returningId();
  const proposalId = proposalRow[0]?.id;
  if (!proposalId) throw new Error("Proposal formalization failed");

  const contractRow = await tx.insert(contracts).values({
    number: salesCommandReference(event.saleId),
    externalSource: "sales-command",
    externalSaleId: event.saleId,
    customerId,
    proposalId,
    resortId: resort.id,
    sellerId: null,
    usageModel: terms.usageModel,
    status: "pending_signature",
    totalAmount: money(event.sale.vgvCents),
    notes: `Sales Command encounter ${event.encounterId}; policy sale_terms/${termsRow.version}; correlation ${event.correlationId}.`,
  }).$returningId();
  const contractId = contractRow[0]?.id;
  if (!contractId) throw new Error("Contract formalization failed");

  const available = await tx.select().from(commercialFractions).where(and(
    eq(commercialFractions.resortId, resort.id),
    eq(commercialFractions.status, "available"),
  )).orderBy(asc(commercialFractions.id)).limit(event.sale.quotasCount).for("update");
  if (available.length !== event.sale.quotasCount) throw new SalesIngestRejection("INSUFFICIENT_INVENTORY", "Insufficient commercial fraction inventory for confirmed sale");
  const fractionIds = available.map((item: typeof commercialFractions.$inferSelect) => item.id);
  const holdAtFormalization = isInventoryHoldAtFormalizationEnabled();
  for (const fraction of available) {
    if (holdAtFormalization) {
      // CRM-E1: reserva com prazo até o administrativo conferir comprovante e documentação; a cota só vira vendida lá.
      await holdFractionForFormalization(tx, fraction, { contractId, proposalId, userId: null });
      continue;
    }
    const updateResult = await tx.update(commercialFractions).set({
      status: "sold",
      currentProposalId: proposalId,
      currentContractId: contractId,
      heldUntil: null,
      blockedReason: null,
    }).where(and(eq(commercialFractions.id, fraction.id), eq(commercialFractions.status, "available")));
    if ((affectedRows(updateResult) ?? 1) !== 1) {
      throw new Error("Commercial fraction was claimed concurrently");
    }
    await tx.insert(commercialFractionHistory).values({
      fractionId: fraction.id,
      fromStatus: "available",
      toStatus: "sold",
      proposalId,
      contractId,
      actorUserId: null,
      reason: "Venda confirmada recebida do Sales Command",
    });
  }

  const primaryMethod = event.sale.paymentMethods[0] ?? null;
  const entryInstallments = allocateReceived(entrySchedule, event.sale.entryReceivedCents, occurredAt, primaryMethod);
  const saleLocalDate = localDateInTimezone(occurredAt, event.project.timezone);
  const firstBalanceDueDate = addDays(saleLocalDate, event.sale.firstBalanceDueInDays);
  const balanceSchedule = balanceCents > 0 ? buildBalanceSchedule({
    balanceCents,
    count: terms.balanceInstallmentCount,
    firstDueDate: firstBalanceDueDate,
    cadenceMonths: terms.balanceCadenceMonths,
    sequenceOffset: entrySchedule.length,
  }) : [];

  const installmentValues = [
    ...entryInstallments.map(item => ({ contractId, ...item })),
    ...balanceSchedule.map(item => ({
      contractId,
      sequence: item.sequence,
      dueDate: dateValue(item.dueDate),
      amount: money(item.amountCents),
      paidAmount: "0.00",
      status: "open" as const,
      paidAt: null,
      paymentMethod: null,
    })),
  ];
  if (installmentValues.length) {
    await tx.insert(installments).values(installmentValues);
    await recordInstallmentsScheduled(tx, { contractId, actorUserId: null });
  }

  if (event.sale.entryReceivedCents > 0) {
    await tx.insert(financialTransactions).values({
      idempotencyKey: salesCommandEntryIdempotencyKey(event.saleId),
      contractId,
      campaignId: null,
      type: "income",
      category: "Entrada Sales Command",
      description: `Entrada recebida na venda Sales Command ${event.saleId}`,
      amount: money(event.sale.entryReceivedCents),
      dueDate: dateValue(saleLocalDate),
      paidAt: occurredAt,
      status: "paid",
      createdByUserId: null,
    });
  }

  const idempotencyKey = `sales-command:sale:${event.saleId}`;
  const lineage = {
    customerId,
    opportunityId,
    proposalId,
    contractId,
    resortId: resort.id,
    saleTermsPolicyId: termsRow.id,
    saleTermsPolicyVersion: termsRow.version,
    saleId: event.saleId,
    encounterId: event.encounterId,
    projectExternalKey: event.project.externalKey,
    projectName: event.project.name,
    projectTimezone: event.project.timezone,
    correlationId: event.correlationId,
    quotasCount: event.sale.quotasCount,
    fractionIds,
    vgvCents: event.sale.vgvCents,
    entryContractedCents: event.sale.entryContractedCents,
    entryReceivedCents: event.sale.entryReceivedCents,
    entryInstallmentCount: event.sale.entryInstallmentCount,
    balanceInstallmentCount: balanceCount,
    firstBalanceDueInDays: event.sale.firstBalanceDueInDays,
    paymentMethods: event.sale.paymentMethods,
  };
  // ADR-004: o contrato vindo do Sales anuncia o valor total ao Financial na mesma transação; a chave impede duplicar no replay.
  await tx.insert(domainEvents).values({
    eventName: "contract.created.v2",
    aggregateType: "contract",
    aggregateId: String(contractId),
    actorUserId: null,
    payload: JSON.stringify({ contractId, saleId: event.saleId, customerId, totalAmount: money(event.sale.vgvCents), currency: "BRL", status: "pending_signature", usageModel: terms.usageModel, source: "sales-command" }),
    idempotencyKey: `sales-command:contract-v2:${event.saleId}`,
    occurredAt,
  });
  await tx.insert(domainEvents).values({
    eventName: "sales.command.sale.ingested",
    aggregateType: "contract",
    aggregateId: String(contractId),
    actorUserId: null,
    payload: JSON.stringify(lineage),
    idempotencyKey,
    occurredAt,
  });
  await tx.insert(auditLogs).values({
    actorUserId: null,
    entityType: "contract",
    entityId: String(contractId),
    action: "sales_command_formalized",
    summary: `Venda ${event.saleId} formalizada em cliente, oportunidade, proposta, contrato e ${installmentValues.length} parcelas.`,
    idempotencyKey: "audit:" + idempotencyKey,
  });
  if (captureLink) {
    // Sem PII: ids, o jeito do vínculo e se o código do casal foi gravado (o código em si não entra na trilha).
    await tx.insert(auditLogs).values({
      actorUserId: null,
      entityType: "capture",
      entityId: String(captureLink.captureId),
      action: captureLink.by === "created" ? "sale_bridge_capture_created" : "sale_bridge_capture_linked",
      summary: `Venda ${event.saleId}: ficha ${captureLink.captureId} ${captureLink.by === "created" ? "criada" : "reaproveitada"} (${captureLink.by}); código do casal ${captureLink.codeWritten ? "gravado" : "não gravado"}.`,
      idempotencyKey: "audit:sale-bridge-capture:" + event.saleId,
    });
  }

  await fixContractCommissionRoleMapAtFormalization(tx, contractId); // item 5: mapa de papéis fixado com o contrato (flag OFF = no-op)
  // C2/C3: a venda confirmada tira o casal do feed (contrato novo). Último passo da tx de formalização; falha do gancho não derruba a venda. Flag OFF = no-op.
  await eligibilityHook(tx, { customerId });

  return {
    customerId,
    opportunityId,
    proposalId,
    contractId,
    installmentCount: installmentValues.length,
    fractionIds,
    replay: false as const,
  };
}

async function handleSalesCommandSale(request: Request, response: Response, integrationKey: string) {
  const authorization = request.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied || !safeEqual(supplied, integrationKey)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = salesCommandSaleSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid event" });
    return;
  }
  const db = await getDb();
  if (!db) {
    response.status(503).json({ error: "Database unavailable" });
    return;
  }
  const event = parsed.data;
  const already = await findFormalization(db, event.saleId);
  if (already?.inventoryLostAt) {
    // CRM-E1: a reserva venceu antes da conferência e a cota voltou ao estoque; o Sales não pode seguir como se a venda estivesse formalizada.
    response.status(422).json({ accepted: false, code: INVENTORY_HELD_EXPIRED_CODE, error: "A reserva da cota venceu antes da conferência; refaça a venda." });
    return;
  }
  if (already) {
    await syncRevenueQualityForContract({ contractId: already.contractId, actorUserId: null, trigger: "replay Sales Command" });
    response.status(200).json({ accepted: true, replay: true, ...already, saleId: event.saleId });
    return;
  }

  let result: Awaited<ReturnType<typeof materializeSalesCommandSale>>;
  try {
    // Deadlock do InnoDB derruba a transação inteira e manda repetir; a materialização é idempotente por saleId, então repetir é seguro.
    result = await withDeadlockRetry(() => db.transaction(tx => materializeSalesCommandSale(tx, event)));
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await findFormalization(db, event.saleId);
      if (raced?.inventoryLostAt) { response.status(422).json({ accepted: false, code: INVENTORY_HELD_EXPIRED_CODE, error: "A reserva da cota venceu antes da conferência; refaça a venda." }); return; }
      if (raced) {
        await syncRevenueQualityForContract({ contractId: raced.contractId, actorUserId: null, trigger: "race replay Sales Command" });
        response.status(200).json({ accepted: true, replay: true, ...raced, saleId: event.saleId });
        return;
      }
    }
    const mapped = mapSalesIngestError(error);
    const context = { code: mapped.code, saleId: event.saleId, correlationId: (event as { correlationId?: string }).correlationId ?? null };
    if (mapped.status === 422) logger.warn("Sales Command sale rejected by a domain rule", context);
    else logger.error("Sales Command ingest failed", { ...context, errorName: error instanceof Error ? error.name : "non-Error" });
    // 422 traz a razão (texto de domínio, sem PII); 503 continua genérico.
    response.status(mapped.status).json(salesIngestFailureBody(mapped, error));
    return;
  }

  // Depois de um deadlock repetido, a nova tentativa pode achar a venda já formalizada por uma requisição concorrente: é replay (200), não criação (201).
  await syncRevenueQualityForContract({ contractId: result.contractId, actorUserId: null, trigger: result.replay ? "race replay Sales Command" : "formalização Sales Command" });
  response.status(result.replay ? 200 : 201).json({ accepted: true, ...result, saleId: event.saleId });
}

export function registerSalesCommandBridge(app: Express, integrationKey: string | undefined) {
  app.post("/api/integrations/sales-command", async (request, response) => {
    const key = integrationKey?.trim();
    if (!key) {
      response.status(503).json({ error: "Integration unavailable" });
      return;
    }
    try {
      await handleSalesCommandSale(request, response, key);
    } catch (error) {
      logger.error("Sales Command ingest failed outside the transaction", { errorName: error instanceof Error ? error.name : "non-Error" });
      if (!response.headersSent) response.status(503).json({ accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" });
    }
  });
}
