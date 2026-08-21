import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, contracts, customerInteractions, customers, domainEvents, financialTransactions, installments, opportunities, reservationWaitlist, reservations, salesCampaigns, salesGoals, tasks, unitMaintenanceBlocks, units, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { internalProcedure } from "./access";
import { buildCommercialCharts, filterFunnelDetails, funnelStages } from "../commercialMetrics";
import { buildOperationalInsights } from "../operationalAnalytics";
import { buildConversionBreakdown, calculateConversionMetrics, filterConversionCaptures } from "../salesRoomAnalytics";

function monthBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { now, start, end };
}

const chartFilters = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), sellerId: z.number().int().positive().optional(), campaignId: z.number().int().positive().optional() }).optional();
const funnelDetailsInput = z.object({ stage: z.enum(funnelStages), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), sellerId: z.number().int().positive().optional(), campaignId: z.number().int().positive().optional() });
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
    if (!db) return { funnel: funnelStages.map(stage => ({ stage, count: 0, amount: 0 })), goals: [], sellers: [], campaigns: [], range: { start, end } };
    const [opportunityRows, goalRows, sellerRows, campaignRows] = await Promise.all([
      db.select().from(opportunities), db.select({ goal: salesGoals, sellerName: users.name }).from(salesGoals).innerJoin(users, eq(salesGoals.sellerId, users.id)), db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.role, "seller")), db.select({ id: salesCampaigns.id, name: salesCampaigns.name }).from(salesCampaigns).where(eq(salesCampaigns.status, "active")),
    ]);
    return { ...buildCommercialCharts(opportunityRows, goalRows.map(({ goal, sellerName }) => ({ ...goal, sellerName })), start, end, input?.sellerId, input?.campaignId), sellers: sellerRows.map(item => ({ id: item.id, name: item.name || item.email || "Vendedor" })), campaigns: campaignRows, range: { start, end } };
  }),
  funnelDetails: internalProcedure.input(funnelDetailsInput).query(async ({ input }) => {
    const db = await getDb(); const { start, end } = resolveRange(input);
    if (!db) return [];
    const rows = await db.select({ opportunity: opportunities, customerName: customers.fullName, sellerName: users.name }).from(opportunities).innerJoin(customers, eq(opportunities.customerId, customers.id)).leftJoin(users, eq(opportunities.sellerId, users.id));
    const selectedIds = new Set(filterFunnelDetails(rows.map(({ opportunity }) => opportunity), input.stage, start, end, input.sellerId, input.campaignId).map(item => item.id));
    return rows.filter(({ opportunity }) => selectedIds.has(opportunity.id)).map(({ opportunity, customerName, sellerName }) => ({ opportunity, customerName, sellerName: sellerName || "Sem vendedor" }));
  }),
  salesRoomConversion: internalProcedure.input(chartFilters).query(async ({ input }) => {
    const db = await getDb(); const { start, end } = resolveRange(input);
    if (!db) return { metrics: calculateConversionMetrics([]), breakdowns: { campaigns: [], promoters: [], liners: [], closers: [] }, range: { start, end } };
    const [captureRows, campaignRows, userRows] = await Promise.all([
      db.select({ capture: captureRecords, opportunityStage: opportunities.stage }).from(captureRecords).leftJoin(opportunities, eq(captureRecords.opportunityId, opportunities.id)),
      db.select({ id: salesCampaigns.id, name: salesCampaigns.name }).from(salesCampaigns),
      db.select({ id: users.id, name: users.name, email: users.email }).from(users),
    ]);
    const captures = filterConversionCaptures(captureRows.map(row => ({ ...row.capture, opportunityStage: row.opportunityStage ?? null })), start, end, input?.campaignId);
    const names = { campaigns: new Map(campaignRows.map(item => [item.id, item.name])), users: new Map(userRows.map(item => [item.id, item.name || item.email || `Usuário #${item.id}`])) };
    return {
      metrics: calculateConversionMetrics(captures),
      breakdowns: {
        campaigns: buildConversionBreakdown({ captures, dimension: "campaign", names }),
        promoters: buildConversionBreakdown({ captures, dimension: "promoter", names }),
        liners: buildConversionBreakdown({ captures, dimension: "liner", names }),
        closers: buildConversionBreakdown({ captures, dimension: "closer", names }),
      },
      range: { start, end },
    };
  }),
  operationalPulse: internalProcedure.query(async () => {
    const db = await getDb(); if (!db) return { exceptions: [], adoption: { eventsLast30Days: 0, activeOperators: 0, interactionsLast30Days: 0 } };
    const now = new Date(); const cutoff = new Date(now.getTime() - 30 * 86_400_000);
    const [installmentRows, taskRows, maintenanceRows, waitlistRows, eventRows, interactionRows] = await Promise.all([
      db.select({ installment: installments, customerName: customers.fullName, contractNumber: contracts.number }).from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).innerJoin(customers, eq(contracts.customerId, customers.id)),
      db.select({ task: tasks, customerName: customers.fullName }).from(tasks).leftJoin(customers, eq(tasks.customerId, customers.id)).orderBy(tasks.dueAt),
      db.select().from(unitMaintenanceBlocks).orderBy(desc(unitMaintenanceBlocks.startsAt)),
      db.select({ item: reservationWaitlist, customerName: customers.fullName }).from(reservationWaitlist).innerJoin(customers, eq(reservationWaitlist.customerId, customers.id)),
      db.select({ actorUserId: domainEvents.actorUserId }).from(domainEvents).where(sql`${domainEvents.occurredAt} >= ${cutoff}`),
      db.select({ id: customerInteractions.id }).from(customerInteractions).where(sql`${customerInteractions.occurredAt} >= ${cutoff}`),
    ]);
    return buildOperationalInsights({ exceptions: [
      ...installmentRows.map(row => ({ id: row.installment.id, kind: "installment" as const, label: `${row.customerName} · ${row.contractNumber}`, dueAt: row.installment.dueDate, status: row.installment.status, amount: row.installment.amount })),
      ...taskRows.map(row => ({ id: row.task.id, kind: "task" as const, label: row.task.title, dueAt: row.task.dueAt, status: row.task.status })),
      ...maintenanceRows.map(row => ({ id: row.id, kind: "maintenance" as const, label: `Unidade #${row.unitId}`, dueAt: row.startsAt, status: row.status })),
      ...waitlistRows.map(row => ({ id: row.item.id, kind: "waitlist" as const, label: row.customerName, dueAt: row.item.expiresAt, status: row.item.status })),
    ], eventsLast30Days: eventRows, interactionsLast30Days: interactionRows.length }, now);
  }),
});
