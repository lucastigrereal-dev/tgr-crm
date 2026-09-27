import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
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
import { syncRevenueQualityForContract } from "./revenueQualitySync";

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
    timezone: z.string().trim().min(1).max(80),
  }),
  saleId: z.string().trim().min(1).max(120),
  encounterId: z.string().trim().min(1).max(120),
  customer: z.strictObject({
    name: z.string().trim().min(2).max(255),
    phone: z.string().trim().max(32).optional(),
  }),
  sale: z.strictObject({
    quotasCount: z.number().int().min(1).max(104),
    vgvCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    entryContractedCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    entryReceivedCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    entryInstallmentCount: z.number().int().min(1).max(100),
    entrySchedule: z.array(entryScheduleRow).min(1).max(100),
    firstBalanceDueInDays: z.number().int().min(0).max(365),
    paymentMethods: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  }),
});

export type SalesCommandSale = z.infer<typeof salesCommandSaleSchema>;

function safeEqual(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function isDuplicateKeyError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || Number(candidate.code) === 1062 || Number(candidate.errno) === 1062;
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
  if (!isStrictCalendarDate(value)) throw new Error("Invalid calendar date");
  return new Date(`${value}T12:00:00Z`);
}

function validateCommercialSnapshot(event: SalesCommandSale) {
  const ordered = [...event.sale.entrySchedule].sort((left, right) => left.sequence - right.sequence);
  if (ordered.length !== event.sale.entryInstallmentCount) throw new Error("Entry schedule count mismatch");
  if (ordered.some((row, index) => row.sequence !== index + 1)) throw new Error("Entry schedule must be contiguous");
  const entryTotal = ordered.reduce((sum, row) => sum + row.amountCents, 0);
  if (!Number.isSafeInteger(entryTotal) || entryTotal !== event.sale.entryContractedCents) throw new Error("Entry schedule total mismatch");
  if (event.sale.entryContractedCents > event.sale.vgvCents) throw new Error("Entry cannot exceed VGV");
  if (event.sale.entryReceivedCents > event.sale.entryContractedCents) throw new Error("Received entry cannot exceed contracted entry");
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
    installmentCount: installmentRows.length,
    fractionIds: fractionRows.map((row: { id: number }) => row.id),
  };
}

async function resolveResort(tx: any, project: SalesCommandSale["project"]) {
  const byKey = (await tx.select().from(resorts).where(eq(resorts.externalKey, project.externalKey)).limit(1).for("update"))[0];
  if (byKey) {
    if (byKey.name !== project.name) throw new Error("Project external key is mapped to another resort name");
    return byKey;
  }
  const byName = (await tx.select().from(resorts).where(eq(resorts.name, project.name)).limit(1).for("update"))[0];
  if (!byName) throw new Error("Sales Command project is not mapped to a CRM resort");
  if (byName.externalKey && byName.externalKey !== project.externalKey) throw new Error("CRM resort is already mapped to another Sales Command project");
  if (!byName.externalKey) {
    await tx.update(resorts).set({ externalKey: project.externalKey }).where(and(eq(resorts.id, byName.id), isNull(resorts.externalKey)));
  }
  return { ...byName, externalKey: project.externalKey };
}

async function resolveSaleTerms(tx: any, resortId: number, occurredAt: Date) {
  const rows = await tx.select().from(commercialPolicyVersions).where(and(
    eq(commercialPolicyVersions.resortId, resortId),
    eq(commercialPolicyVersions.policyType, "sale_terms"),
    isNull(commercialPolicyVersions.retiredAt),
    lte(commercialPolicyVersions.effectiveAt, occurredAt),
  )).orderBy(desc(commercialPolicyVersions.effectiveAt), desc(commercialPolicyVersions.id)).limit(2);
  const policy = rows[0];
  if (!policy) throw new Error("Active sale_terms policy required before CRM formalization");
  const sameEffective = rows[1] && rows[1].effectiveAt.getTime() === policy.effectiveAt.getTime();
  if (sameEffective) throw new Error("Ambiguous sale_terms policy effective date");
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

export async function materializeSalesCommandSale(tx: any, event: SalesCommandSale) {
  const existing = await findFormalization(tx, event.saleId);
  if (existing) return { ...existing, replay: true as const };

  const occurredAt = new Date(event.occurredAt);
  const entrySchedule = validateCommercialSnapshot(event);
  const resort = await resolveResort(tx, event.project);
  const { row: termsRow, terms } = await resolveSaleTerms(tx, resort.id, occurredAt);

  let customerId: number | undefined;
  if (event.customer.phone) {
    const [matched] = await tx.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.phone, event.customer.phone), eq(customers.fullName, event.customer.name))).limit(1);
    customerId = matched?.id;
  }
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

  const opportunityRow = await tx.insert(opportunities).values({
    customerId,
    title: "Venda Sales Command " + event.saleId.slice(0, 12),
    stage: "won",
    source: "Sales Command",
    expectedAmount: money(event.sale.vgvCents),
    probability: 100,
    closedAt: occurredAt,
  }).$returningId();
  const opportunityId = opportunityRow[0]?.id;
  if (!opportunityId) throw new Error("Opportunity formalization failed");

  await tx.insert(captureRecords).values({
    customerId,
    resortId: resort.id,
    opportunityId,
    captureLocation: "Sales Command",
    presentationStatus: "closed",
    qualificationStatus: "qualified",
    notes: `Formalização automática da venda ${event.saleId}.`,
  });

  const balanceCents = event.sale.vgvCents - event.sale.entryContractedCents;
  const balanceCount = balanceCents > 0 ? terms.balanceInstallmentCount : 0;
  const totalInstallments = entrySchedule.length + balanceCount;
  if (totalInstallments > 360) throw new Error("Combined contract installment schedule exceeds supported limit of 360");
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
  if (available.length !== event.sale.quotasCount) throw new Error("Insufficient commercial fraction inventory for confirmed sale");
  const fractionIds = available.map((item: typeof commercialFractions.$inferSelect) => item.id);
  for (const fraction of available) {
    const updateResult = await tx.update(commercialFractions).set({
      status: "sold",
      currentProposalId: proposalId,
      currentContractId: contractId,
      heldUntil: null,
      blockedReason: null,
    }).where(and(eq(commercialFractions.id, fraction.id), eq(commercialFractions.status, "available")));
    if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) !== 1) {
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
  if (installmentValues.length) await tx.insert(installments).values(installmentValues);

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
  if (already) {
    await syncRevenueQualityForContract({ contractId: already.contractId, actorUserId: null, trigger: "replay Sales Command" });
    response.status(200).json({ accepted: true, replay: true, ...already, saleId: event.saleId });
    return;
  }

  let result: Awaited<ReturnType<typeof materializeSalesCommandSale>>;
  try {
    result = await db.transaction(tx => materializeSalesCommandSale(tx, event));
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await findFormalization(db, event.saleId);
      if (raced) {
        await syncRevenueQualityForContract({ contractId: raced.contractId, actorUserId: null, trigger: "race replay Sales Command" });
        response.status(200).json({ accepted: true, replay: true, ...raced, saleId: event.saleId });
        return;
      }
    }
    throw error;
  }

  await syncRevenueQualityForContract({ contractId: result.contractId, actorUserId: null, trigger: "formalização Sales Command" });
  response.status(201).json({ accepted: true, ...result, saleId: event.saleId });
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
    } catch {
      response.status(503).json({ error: "Event processing failed" });
    }
  });
}
