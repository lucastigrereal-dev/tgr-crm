import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, commercialProjectSettings, contractCancellationRequests, contractDocuments, contracts, customerInteractions, customers, domainEvents, financialTransactions, installments, opportunities, proposals, reservationWaitlist, reservations, resorts, salesCampaigns, salesCommissions, salesGoals, tasks, unitMaintenanceBlocks, units, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { internalProcedure } from "./access";
import { buildCommercialCharts, filterFunnelDetails, funnelStages, latestCaptureByOpportunity } from "../commercialMetrics";
import { buildOperationalInsights } from "../operationalAnalytics";
import { buildConversionBreakdown, calculateConversionMetrics, filterConversionCaptures } from "../salesRoomAnalytics";
import { buildCommercialIntegrityAlerts } from "../commercialIntegrity";
import { parseRequiredContractDocuments } from "../projectPolicy";
import { buildProfessionalRhythmAlerts, type ProfessionalRhythmFact } from "../professionalRhythm";

function monthBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { now, start, end };
}

const chartFilters = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), sellerId: z.number().int().positive().optional(), campaignId: z.number().int().positive().optional(), resortId: z.number().int().positive().optional(), salesRoom: z.string().min(1).max(180).optional(), commercialRole: z.enum(["promoter", "liner", "closer"]).optional(), operatorId: z.number().int().positive().optional(), presentationStatus: z.enum(["captured", "scheduled", "checked_in", "presented", "no_tour", "closed"]).optional() }).optional();
const funnelDetailsInput = z.object({ stage: z.enum(funnelStages), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), sellerId: z.number().int().positive().optional(), campaignId: z.number().int().positive().optional(), resortId: z.number().int().positive().optional(), salesRoom: z.string().min(1).max(180).optional(), commercialRole: z.enum(["promoter", "liner", "closer"]).optional(), operatorId: z.number().int().positive().optional(), presentationStatus: z.enum(["captured", "scheduled", "checked_in", "presented", "no_tour", "closed"]).optional() });
function resolveRange(input?: z.infer<NonNullable<typeof chartFilters>>) {
  const fallback = monthBounds();
  const start = input?.startDate ? new Date(`${input.startDate}T00:00:00Z`) : fallback.start;
  const end = input?.endDate ? new Date(`${input.endDate}T00:00:00Z`) : fallback.end;
  if (end <= start) throw new Error("O fim do período precisa ser posterior ao início.");
  return { start, end: input?.endDate ? new Date(end.getTime() + 86_400_000) : end };
}

// Toda leitura executiva usa intervalo explícito para manter filtros, exports e futuros agentes de IA na mesma verdade temporal.

export const dashboardRouter = router({
  summary: internalProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { activeContracts: 0, overdueAmount: 0, occupancy: 0, salesThisMonth: 0, pendingTasks: 0, openEntries: 0 };
    const { now, start, end } = monthBounds();
    const [contractRows, installmentRows, reservationRows, unitRows, taskRows, salesRows, entryRows] = await Promise.all([
      db.select({ total: sql<number>`count(*)` }).from(contracts).where(eq(contracts.status, "active")), db.select().from(installments), db.select().from(reservations).where(and(sql`${reservations.checkIn} < ${end}`, sql`${reservations.checkOut} > ${start}`, inArray(reservations.status, ["confirmed", "checked_in", "completed"]))), db.select({ total: sql<number>`count(*)` }).from(units).where(eq(units.status, "active")), db.select({ total: sql<number>`count(*)` }).from(tasks).where(inArray(tasks.status, ["open", "in_progress"])), db.select().from(opportunities).where(and(eq(opportunities.stage, "won"), sql`${opportunities.closedAt} >= ${start}`, sql`${opportunities.closedAt} < ${end}`)), db.select({ total: sql<number>`count(*)` }).from(financialTransactions).where(eq(financialTransactions.status, "open")),
    ]);
    const overdueAmount = installmentRows.filter(item => item.status === "overdue" || (item.status === "open" && new Date(item.dueDate) < now)).reduce((sum, item) => sum + Number(item.amount), 0);
    const totalReservationDays = reservationRows.reduce((sum, item) => Math.max(0, sum + Math.ceil((new Date(item.checkOut).getTime() - new Date(item.checkIn).getTime()) / 86_400_000)), 0);
    const totalDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000) * Number(unitRows[0]?.total ?? 0));
    return { activeContracts: Number(contractRows[0]?.total ?? 0), overdueAmount, occupancy: Math.min(100, Math.round((totalReservationDays / totalDays) * 100)), salesThisMonth: salesRows.reduce((sum, item) => sum + Number(item.expectedAmount), 0), pendingTasks: Number(taskRows[0]?.total ?? 0), openEntries: Number(entryRows[0]?.total ?? 0) };
  }),
  commercialCharts: internalProcedure.input(chartFilters).query(async ({ input }) => {
    const db = await getDb(); const { start, end } = resolveRange(input);
    if (!db) return { funnel: funnelStages.map(stage => ({ stage, count: 0, amount: 0 })), goals: [], sellers: [], campaigns: [], filters: { resorts: [], salesRooms: [] }, range: { start, end } };
    const [opportunityRows, captureRows, goalRows, sellerRows, campaignRows, resortRows] = await Promise.all([
      db.select().from(opportunities),
      db.select().from(captureRecords),
      db.select({ goal: salesGoals, sellerName: users.name }).from(salesGoals).innerJoin(users, eq(salesGoals.sellerId, users.id)),
      db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.role, "seller")),
      db.select({ id: salesCampaigns.id, name: salesCampaigns.name }).from(salesCampaigns).where(eq(salesCampaigns.status, "active")),
      db.select({ id: resorts.id, name: resorts.name }).from(resorts).where(eq(resorts.status, "active")),
    ]);
    const capturesByOpportunity = latestCaptureByOpportunity(captureRows);
    const needsOperationalContext = Boolean(input?.resortId || input?.salesRoom || input?.commercialRole || input?.operatorId || input?.presentationStatus);
    const filteredOpportunities = opportunityRows.filter(opportunity => {
      if (!needsOperationalContext) return true;
      const capture = capturesByOpportunity.get(opportunity.id);
      if (!capture) return false;
      const operatorId = input?.commercialRole === "promoter" ? capture.promoterId : input?.commercialRole === "liner" ? capture.linerId : input?.commercialRole === "closer" ? capture.closerId : null;
      return (!input?.resortId || capture.resortId === input.resortId) && (!input?.salesRoom || capture.salesRoom === input.salesRoom) && (!input?.presentationStatus || capture.presentationStatus === input.presentationStatus) && (!input?.operatorId || operatorId === input.operatorId);
    });
    return { ...buildCommercialCharts(filteredOpportunities, goalRows.map(({ goal, sellerName }) => ({ ...goal, sellerName })), start, end, input?.sellerId, input?.campaignId), sellers: sellerRows.map(item => ({ id: item.id, name: item.name || item.email || "Vendedor" })), campaigns: campaignRows, filters: { resorts: resortRows, salesRooms: Array.from(new Set(captureRows.map(item => item.salesRoom).filter((value): value is string => Boolean(value)))).sort() }, range: { start, end } };
  }),
  funnelDetails: internalProcedure.input(funnelDetailsInput).query(async ({ input }) => {
    const db = await getDb(); const { start, end } = resolveRange(input);
    if (!db) return [];
    const [rows, captureRows] = await Promise.all([
      db.select({ opportunity: opportunities, customerName: customers.fullName, sellerName: users.name }).from(opportunities).innerJoin(customers, eq(opportunities.customerId, customers.id)).leftJoin(users, eq(opportunities.sellerId, users.id)),
      db.select().from(captureRecords),
    ]);
    const selectedIds = new Set(filterFunnelDetails(rows.map(({ opportunity }) => opportunity), input.stage, start, end, input.sellerId, input.campaignId).map(item => item.id));
    const capturesByOpportunity = latestCaptureByOpportunity(captureRows);
    const needsOperationalContext = Boolean(input.resortId || input.salesRoom || input.commercialRole || input.operatorId || input.presentationStatus);
    return rows.filter(({ opportunity }) => {
      if (!selectedIds.has(opportunity.id)) return false;
      if (!needsOperationalContext) return true;
      const capture = capturesByOpportunity.get(opportunity.id);
      if (!capture) return false;
      const operatorId = input.commercialRole === "promoter" ? capture.promoterId : input.commercialRole === "liner" ? capture.linerId : input.commercialRole === "closer" ? capture.closerId : null;
      return (!input.resortId || capture.resortId === input.resortId) && (!input.salesRoom || capture.salesRoom === input.salesRoom) && (!input.presentationStatus || capture.presentationStatus === input.presentationStatus) && (!input.operatorId || operatorId === input.operatorId);
    }).map(({ opportunity, customerName, sellerName }) => ({ opportunity, customerName, sellerName: sellerName || "Sem vendedor" }));
  }),
  salesRoomConversion: internalProcedure.input(chartFilters).query(async ({ input }) => {
    const db = await getDb(); const { start, end } = resolveRange(input);
    if (!db) return { metrics: calculateConversionMetrics([]), breakdowns: { campaigns: [], promoters: [], liners: [], closers: [] }, range: { start, end } };
    const [captureRows, campaignRows, userRows, resortRows] = await Promise.all([
      db.select({ capture: captureRecords, opportunityStage: opportunities.stage }).from(captureRecords).leftJoin(opportunities, eq(captureRecords.opportunityId, opportunities.id)),
      db.select({ id: salesCampaigns.id, name: salesCampaigns.name }).from(salesCampaigns),
      db.select({ id: users.id, name: users.name, email: users.email }).from(users),
      db.select({ id: resorts.id, name: resorts.name }).from(resorts).where(eq(resorts.status, "active")),
    ]);
    const captures = filterConversionCaptures(captureRows.map(row => ({ ...row.capture, opportunityStage: row.opportunityStage ?? null })), start, end, input?.campaignId, input?.resortId, input?.salesRoom, input?.commercialRole, input?.operatorId, input?.presentationStatus);
    const names = { campaigns: new Map(campaignRows.map(item => [item.id, item.name])), users: new Map(userRows.map(item => [item.id, item.name || item.email || `Usuário #${item.id}`])) };
    return {
      metrics: calculateConversionMetrics(captures),
      breakdowns: {
        campaigns: buildConversionBreakdown({ captures, dimension: "campaign", names }),
        promoters: buildConversionBreakdown({ captures, dimension: "promoter", names }),
        liners: buildConversionBreakdown({ captures, dimension: "liner", names }),
        closers: buildConversionBreakdown({ captures, dimension: "closer", names }),
      },
      filters: { resorts: resortRows, salesRooms: Array.from(new Set(captureRows.map(row => row.capture.salesRoom).filter((value): value is string => Boolean(value)))).sort(), operators: userRows.map(item => ({ id: item.id, name: item.name || item.email || `Usuário #${item.id}` })) }, range: { start, end },
    };
  }),
  operationalPulse: internalProcedure.query(async () => {
    const db = await getDb(); if (!db) return { exceptions: [], adoption: { eventsLast30Days: 0, activeOperators: 0, interactionsLast30Days: 0 } };
    const now = new Date(); const cutoff = new Date(now.getTime() - 30 * 86_400_000);
    const [installmentRows, taskRows, maintenanceRows, waitlistRows, eventRows, interactionRows, captureRows, opportunityRows, cancellationRows, commissionRows, contractRows, documentRows, settingsRows, rhythmCaptureRows, userRows] = await Promise.all([
      db.select({ installment: installments, customerName: customers.fullName, contractNumber: contracts.number }).from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id)),
      db.select({ task: tasks, customerName: customers.fullName }).from(tasks).leftJoin(customers, eq(tasks.customerId, customers.id)).orderBy(tasks.dueAt),
      db.select().from(unitMaintenanceBlocks).orderBy(desc(unitMaintenanceBlocks.startsAt)),
      db.select({ item: reservationWaitlist, customerName: customers.fullName }).from(reservationWaitlist).innerJoin(customers, eq(reservationWaitlist.customerId, customers.id)),
      db.select({ actorUserId: domainEvents.actorUserId }).from(domainEvents).where(sql`${domainEvents.occurredAt} >= ${cutoff}`),
      db.select({ id: customerInteractions.id }).from(customerInteractions).where(sql`${customerInteractions.occurredAt} >= ${cutoff}`),
      db.select({ capture: captureRecords, customerName: customers.fullName }).from(captureRecords).innerJoin(customers, eq(captureRecords.customerId, customers.id)).where(eq(captureRecords.presentationStatus, "captured")),
      db.select({ opportunity: opportunities, customerName: customers.fullName }).from(opportunities).innerJoin(customers, eq(opportunities.customerId, customers.id)).where(inArray(opportunities.stage, ["proposal", "negotiation"])),
      db.select({ request: contractCancellationRequests, contractNumber: contracts.number }).from(contractCancellationRequests).innerJoin(contracts, eq(contractCancellationRequests.contractId, contracts.id)).where(eq(contractCancellationRequests.status, "requested")),
      db.select({ commission: salesCommissions, sellerName: users.name, sourceInstallmentStatus: installments.status }).from(salesCommissions).leftJoin(users, eq(salesCommissions.sellerId, users.id)).leftJoin(installments, eq(salesCommissions.sourceInstallmentId, installments.id)),
      db.select({ contract: contracts, customerName: customers.fullName, resortId: captureRecords.resortId, captureCreatedAt: captureRecords.createdAt }).from(contracts).innerJoin(customers, eq(contracts.customerId, customers.id)).leftJoin(proposals, eq(contracts.proposalId, proposals.id)).leftJoin(opportunities, eq(proposals.opportunityId, opportunities.id)).leftJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id)),
      db.select().from(contractDocuments),
      db.select().from(commercialProjectSettings),
      db.select().from(captureRecords),
      db.select({ id: users.id, name: users.name, email: users.email }).from(users),
    ]);
    const integrityAlerts = buildCommercialIntegrityAlerts({ commissions: commissionRows.map(row => ({ id: row.commission.id, contractId: row.commission.contractId ?? 0, amount: Number(row.commission.amount), status: row.commission.status, sourceInstallmentId: row.commission.sourceInstallmentId, sourceInstallmentStatus: row.sourceInstallmentStatus })), proposals: [], contracts: [], duplicateCandidates: [], opportunities: [] });
    const settingsByResort = new Map(settingsRows.map(row => [row.resortId, parseRequiredContractDocuments(row.requiredContractDocuments)]));
    const documentsByContract = new Map<number, Set<string>>();
    for (const document of documentRows) { const categories = documentsByContract.get(document.contractId) || new Set<string>(); categories.add(document.category); documentsByContract.set(document.contractId, categories); }
    const latestContractContext = new Map<number, typeof contractRows[number]>();
    for (const row of contractRows) { const current = latestContractContext.get(row.contract.id); if (!current || (row.captureCreatedAt?.getTime() || 0) > (current.captureCreatedAt?.getTime() || 0)) latestContractContext.set(row.contract.id, row); }
    const documentIntegrityAlerts = Array.from(latestContractContext.values()).flatMap(row => {
      if (row.contract.status !== "active" || !row.resortId) return [];
      const required = settingsByResort.get(row.resortId) || [];
      if (!required.length) return [];
      const present = documentsByContract.get(row.contract.id) || new Set<string>();
      const missing = required.filter(category => !present.has(category));
      return missing.length ? [{ id: row.contract.id, kind: "integrity" as const, label: `Documentos pendentes · ${row.contract.number}`, status: "attention", responsibleRole: "Contratos", evidence: `Associado ${row.customerName}: ausentes pela política do empreendimento — ${missing.join(", ")}.` }] : [];
    });
    const rhythmRosterMap = new Map<string, { userId: number; role: "promoter" | "qualifier" | "liner" | "closer" | "room_manager" }>();
    for (const capture of rhythmCaptureRows) {
      if (capture.promoterId) rhythmRosterMap.set(`promoter-${capture.promoterId}`, { userId: capture.promoterId, role: "promoter" });
      if (capture.qualifierId) rhythmRosterMap.set(`qualifier-${capture.qualifierId}`, { userId: capture.qualifierId, role: "qualifier" });
      if (capture.linerId) rhythmRosterMap.set(`liner-${capture.linerId}`, { userId: capture.linerId, role: "liner" });
      if (capture.closerId) rhythmRosterMap.set(`closer-${capture.closerId}`, { userId: capture.closerId, role: "closer" });
      if (capture.roomManagerId) rhythmRosterMap.set(`room_manager-${capture.roomManagerId}`, { userId: capture.roomManagerId, role: "room_manager" });
    }
    const rhythmRoster = Array.from(rhythmRosterMap.values());
    const rhythmFacts: ProfessionalRhythmFact[] = [];
    for (const capture of rhythmCaptureRows) {
      if (capture.promoterId) rhythmFacts.push({ userId: capture.promoterId, role: "promoter", eventAt: capture.createdAt, label: "Captação registrada", entityId: capture.id });
      if (capture.qualifierId && capture.qualificationStatus === "qualified" && capture.checkedInAt) rhythmFacts.push({ userId: capture.qualifierId, role: "qualifier", eventAt: capture.checkedInAt, label: "Qualificação concluída", entityId: capture.id });
      if (capture.linerId && capture.presentationStartedAt) rhythmFacts.push({ userId: capture.linerId, role: "liner", eventAt: capture.presentationStartedAt, label: "Apresentação iniciada", entityId: capture.id });
      if (capture.closerId && capture.presentationEndedAt) rhythmFacts.push({ userId: capture.closerId, role: "closer", eventAt: capture.presentationEndedAt, label: "Apresentação encerrada", entityId: capture.id });
      if (capture.roomManagerId && capture.assignedAt) rhythmFacts.push({ userId: capture.roomManagerId, role: "room_manager", eventAt: capture.assignedAt, label: "Mesa atribuída", entityId: capture.id });
    }
    const userNames = new Map(userRows.map(user => [user.id, user.name || user.email || `Usuário #${user.id}`]));
    const rhythmAlerts = buildProfessionalRhythmAlerts({ roster: rhythmRoster, facts: rhythmFacts, now });
    return buildOperationalInsights({ exceptions: [
      ...installmentRows.map(row => ({ id: row.installment.id, kind: "installment" as const, label: `${row.customerName} · ${row.contractNumber}`, dueAt: row.installment.dueDate, status: row.installment.status, amount: row.installment.amount })),
      ...taskRows.map(row => ({ id: row.task.id, kind: "task" as const, label: row.task.title, dueAt: row.task.dueAt, status: row.task.status })),
      ...maintenanceRows.map(row => ({ id: row.id, kind: "maintenance" as const, label: `Unidade #${row.unitId}`, dueAt: row.startsAt, status: row.status })),
      ...waitlistRows.map(row => ({ id: row.item.id, kind: "waitlist" as const, label: row.customerName, dueAt: row.item.expiresAt, status: row.item.status })),
      ...captureRows.map(row => ({ id: row.capture.id, kind: "capture" as const, label: row.customerName, dueAt: row.capture.createdAt, status: row.capture.presentationStatus })),
      ...opportunityRows.map(row => ({ id: row.opportunity.id, kind: "opportunity" as const, label: `${row.customerName} · ${row.opportunity.title}`, dueAt: row.opportunity.nextFollowUpAt, status: row.opportunity.nextFollowUpAt && row.opportunity.nextFollowUpAt < now ? "overdue_followup" : "missing_followup" })),
      ...cancellationRows.map(row => ({ id: row.request.id, kind: "cancellation" as const, label: row.contractNumber, status: row.request.status })),
      ...commissionRows.map(row => ({ id: row.commission.id, kind: "commission" as const, label: row.sellerName || `Comissão #${row.commission.id}`, dueAt: row.commission.expectedPaymentAt, status: row.commission.status })),
      ...integrityAlerts.map(alert => ({ id: alert.entityId, kind: "integrity" as const, label: alert.code.replaceAll("_", " "), status: alert.severity, responsibleRole: alert.ownerRole, evidence: alert.evidence })),
      ...documentIntegrityAlerts,
      ...rhythmAlerts.map(alert => ({ id: alert.userId, kind: "rhythm" as const, label: `${userNames.get(alert.userId) || `Usuário #${alert.userId}`} · ${alert.role}`, status: alert.severity, responsibleRole: "Gerência comercial", dueAt: new Date(now.getTime() + (alert.severity === "critical" ? 0 : 86_400_000)), evidence: `${alert.daysWithoutEvent} dia(s) sem evento relevante. ${alert.evidence} ${alert.recommendedAction}` })),
    ], eventsLast30Days: eventRows, interactionsLast30Days: interactionRows.length }, now);
  }),
});
