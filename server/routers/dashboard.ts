import { and, eq, inArray, sql } from "drizzle-orm";
import { contracts, financialTransactions, installments, opportunities, reservations, tasks, units } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { internalProcedure } from "./access";

function monthBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { now, start, end };
}

export const dashboardRouter = router({
  summary: internalProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { activeContracts: 0, overdueAmount: 0, occupancy: 0, salesThisMonth: 0, pendingTasks: 0, openEntries: 0 };
    const { now, start, end } = monthBounds();
    const [contractRows, installmentRows, reservationRows, unitRows, taskRows, salesRows, entryRows] = await Promise.all([
      db.select({ total: sql<number>`count(*)` }).from(contracts).where(eq(contracts.status, "active")),
      db.select().from(installments),
      db.select().from(reservations).where(and(sql`${reservations.checkIn} < ${end}`, sql`${reservations.checkOut} > ${start}`, inArray(reservations.status, ["confirmed", "checked_in", "completed"]))),
      db.select({ total: sql<number>`count(*)` }).from(units).where(eq(units.status, "active")),
      db.select({ total: sql<number>`count(*)` }).from(tasks).where(inArray(tasks.status, ["open", "in_progress"])),
      db.select().from(opportunities).where(and(eq(opportunities.stage, "won"), sql`${opportunities.closedAt} >= ${start}`, sql`${opportunities.closedAt} < ${end}`)),
      db.select({ total: sql<number>`count(*)` }).from(financialTransactions).where(eq(financialTransactions.status, "open")),
    ]);
    const overdueAmount = installmentRows.filter(item => item.status === "overdue" || (item.status === "open" && new Date(item.dueDate) < now)).reduce((sum, item) => sum + Number(item.amount), 0);
    const totalReservationDays = reservationRows.reduce((sum, item) => Math.max(0, sum + Math.ceil((new Date(item.checkOut).getTime() - new Date(item.checkIn).getTime()) / 86_400_000)), 0);
    const totalDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000) * Number(unitRows[0]?.total ?? 0));
    return { activeContracts: Number(contractRows[0]?.total ?? 0), overdueAmount, occupancy: Math.min(100, Math.round((totalReservationDays / totalDays) * 100)), salesThisMonth: salesRows.reduce((sum, item) => sum + Number(item.expectedAmount), 0), pendingTasks: Number(taskRows[0]?.total ?? 0), openEntries: Number(entryRows[0]?.total ?? 0) };
  }),
});
