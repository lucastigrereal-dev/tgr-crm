import { and, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { contracts, customerInteractions, customers, installments, opportunities, reservations, tasks } from "../../drizzle/schema";
import { analyzeCustomerWithEvidence, buildPermissionedCustomerContext, type AssistantRole } from "../aiAssistant";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { internalProcedure } from "./access";

export const aiRouter = router({
  analyzeCustomer: internalProcedure.input(z.object({ customerId: z.number().int().positive(), question: z.string().trim().min(4).max(800) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const customer = (await db.select({ id: customers.id, fullName: customers.fullName, status: customers.status }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Associado não encontrado." });
    const [interactions, customerContracts, customerOpportunities, customerReservations, customerInstallments, customerTasks] = await Promise.all([
      db.select({ id: customerInteractions.id, type: customerInteractions.type, subject: customerInteractions.subject, content: customerInteractions.content, occurredAt: customerInteractions.occurredAt }).from(customerInteractions).where(eq(customerInteractions.customerId, input.customerId)).orderBy(desc(customerInteractions.occurredAt)).limit(8),
      db.select({ id: contracts.id, number: contracts.number, status: contracts.status }).from(contracts).where(eq(contracts.customerId, input.customerId)).limit(8),
      db.select({ id: opportunities.id, title: opportunities.title, stage: opportunities.stage, expectedAmount: opportunities.expectedAmount }).from(opportunities).where(eq(opportunities.customerId, input.customerId)).orderBy(desc(opportunities.updatedAt)).limit(8),
      db.select({ id: reservations.id, status: reservations.status, checkIn: reservations.checkIn, checkOut: reservations.checkOut }).from(reservations).where(eq(reservations.customerId, input.customerId)).orderBy(desc(reservations.checkIn)).limit(8),
      db.select({ id: installments.id, status: installments.status, dueDate: installments.dueDate, amount: installments.amount }).from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).where(eq(contracts.customerId, input.customerId)).orderBy(desc(installments.dueDate)).limit(12),
      db.select({ id: tasks.id, title: tasks.title, status: tasks.status, dueAt: tasks.dueAt }).from(tasks).where(and(eq(tasks.customerId, input.customerId), inArray(tasks.status, ["open", "in_progress"]))).orderBy(tasks.dueAt).limit(8),
    ]);
    const role = ctx.user.role as AssistantRole;
    const context = buildPermissionedCustomerContext(role, { customer, interactions, contracts: customerContracts, opportunities: customerOpportunities, reservations: customerReservations, installments: customerInstallments, tasks: customerTasks });
    const result = await analyzeCustomerWithEvidence(input.question, context);
    await recordAudit(ctx.user.id, "customer", input.customerId, "ai_assistance_requested", `Assistência IA consultada com ${context.evidence.length} evidência(s).`);
    await recordDomainEvent({ eventName: "ai.assistance.requested", aggregateType: "customer", aggregateId: input.customerId, actorUserId: ctx.user.id, payload: { role, evidenceCount: context.evidence.length, model: result.model } });
    return result;
  }),
});
