import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, opportunities, proposals, salesGoals, tasks, users } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { salesProcedure } from "./access";
import { resolveFollowUpAt } from "../domain";

const opportunityInput = z.object({
  customerId: z.number().int().positive(),
  sellerId: z.number().int().positive().optional().nullable(),
  campaignId: z.number().int().positive().optional().nullable(),
  title: z.string().trim().min(3).max(255),
  stage: z.enum(["new", "qualified", "proposal", "negotiation", "won", "lost"]).default("new"),
  source: z.string().trim().max(120).optional().nullable(),
  expectedAmount: z.coerce.number().min(0).max(999999999),
  probability: z.coerce.number().int().min(0).max(100).default(10),
  nextFollowUpAt: z.string().datetime().optional().nullable(),
  lossReason: z.string().trim().max(2000).optional().nullable(),
});

export const salesRouter = router({
  pipeline: salesProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ opportunity: opportunities, customerName: customers.fullName, sellerName: users.name })
      .from(opportunities)
      .innerJoin(customers, eq(opportunities.customerId, customers.id))
      .leftJoin(users, eq(opportunities.sellerId, users.id))
      .orderBy(desc(opportunities.updatedAt)).limit(120);
  }),

  createOpportunity: salesProcedure.input(opportunityInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const followUpAt = resolveFollowUpAt(input.nextFollowUpAt);
    const result = await db.insert(opportunities).values({
      ...input,
      sellerId: input.sellerId ?? ctx.user.id,
      expectedAmount: input.expectedAmount.toFixed(2),
      source: input.source?.trim() || null,
      nextFollowUpAt: followUpAt,
      lossReason: input.lossReason?.trim() || null,
      closedAt: input.stage === "won" || input.stage === "lost" ? new Date() : null,
    }).$returningId();
    const id = result[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a oportunidade." });
    await db.insert(tasks).values({
      title: `Follow-up comercial: ${input.title}`,
      description: `Follow-up automático criado com a oportunidade comercial #${id}.`,
      type: "follow_up",
      priority: "normal",
      customerId: input.customerId,
      assignedToUserId: input.sellerId ?? ctx.user.id,
      dueAt: followUpAt,
      reminderAt: followUpAt,
      createdByUserId: ctx.user.id,
    });
    await recordAudit(ctx.user.id, "opportunity", id, "created", `Oportunidade ${input.title} criada.`);
    await recordDomainEvent({ eventName: "opportunity.created", aggregateType: "opportunity", aggregateId: id, actorUserId: ctx.user.id, payload: { campaignId: input.campaignId ?? null, sellerId: input.sellerId ?? ctx.user.id, stage: input.stage, expectedAmount: input.expectedAmount } });
    return { id };
  }),

  updateOpportunity: salesProcedure.input(z.object({ id: z.number().int().positive(), data: opportunityInput })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.update(opportunities).set({
      ...input.data,
      expectedAmount: input.data.expectedAmount.toFixed(2),
      source: input.data.source?.trim() || null,
      nextFollowUpAt: input.data.nextFollowUpAt ? new Date(input.data.nextFollowUpAt) : null,
      lossReason: input.data.lossReason?.trim() || null,
      closedAt: input.data.stage === "won" || input.data.stage === "lost" ? new Date() : null,
    }).where(eq(opportunities.id, input.id));
    await recordAudit(ctx.user.id, "opportunity", input.id, "updated", `Oportunidade atualizada para ${input.data.stage}.`);
    await recordDomainEvent({ eventName: "opportunity.updated", aggregateType: "opportunity", aggregateId: input.id, actorUserId: ctx.user.id, payload: { campaignId: input.data.campaignId ?? null, stage: input.data.stage, expectedAmount: input.data.expectedAmount } });
    return { success: true };
  }),

  createProposal: salesProcedure.input(z.object({
    opportunityId: z.number().int().positive(),
    reference: z.string().trim().min(3).max(64),
    productDescription: z.string().trim().min(3).max(5000),
    totalAmount: z.coerce.number().positive().max(999999999),
    downPaymentAmount: z.coerce.number().min(0).max(999999999).default(0),
    installmentCount: z.coerce.number().int().min(1).max(360).default(1),
    status: z.enum(["draft", "sent", "approved", "rejected", "expired"]).default("draft"),
    expiresAt: z.string().date().optional().nullable(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const result = await db.insert(proposals).values({
      ...input,
      totalAmount: input.totalAmount.toFixed(2),
      downPaymentAmount: input.downPaymentAmount.toFixed(2),
      expiresAt: input.expiresAt ? new Date(`${input.expiresAt}T12:00:00Z`) : null,
    }).$returningId();
    const id = result[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a proposta." });
    await db.update(opportunities).set({ stage: input.status === "approved" ? "won" : "proposal", updatedAt: new Date() }).where(eq(opportunities.id, input.opportunityId));
    await recordAudit(ctx.user.id, "proposal", id, "created", `Proposta ${input.reference} criada.`);
    await recordDomainEvent({ eventName: "proposal.created", aggregateType: "proposal", aggregateId: id, actorUserId: ctx.user.id, payload: { opportunityId: input.opportunityId, status: input.status, totalAmount: input.totalAmount } });
    return { id };
  }),

  proposals: salesProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ proposal: proposals, opportunityTitle: opportunities.title, customerName: customers.fullName })
      .from(proposals)
      .innerJoin(opportunities, eq(proposals.opportunityId, opportunities.id))
      .innerJoin(customers, eq(opportunities.customerId, customers.id))
      .orderBy(desc(proposals.updatedAt)).limit(100);
  }),

  goals: salesProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const [goalRows, wonOpportunities] = await Promise.all([
      db.select({ goal: salesGoals, sellerName: users.name }).from(salesGoals).innerJoin(users, eq(salesGoals.sellerId, users.id)).orderBy(desc(salesGoals.monthReference)),
      db.select().from(opportunities).where(eq(opportunities.stage, "won")),
    ]);
    return goalRows.map(row => {
      const reference = new Date(row.goal.monthReference);
      const closed = wonOpportunities.filter(opportunity => {
        if (opportunity.sellerId !== row.goal.sellerId || !opportunity.closedAt) return false;
        const closeDate = new Date(opportunity.closedAt);
        return closeDate.getUTCFullYear() === reference.getUTCFullYear() && closeDate.getUTCMonth() === reference.getUTCMonth();
      });
      return { ...row, currentAmount: closed.reduce((sum, opportunity) => sum + Number(opportunity.expectedAmount), 0), currentContracts: closed.length };
    });
  }),

  createGoal: salesProcedure.input(z.object({
    sellerId: z.number().int().positive(),
    monthReference: z.string().date(),
    targetAmount: z.coerce.number().positive().max(999999999),
    targetContracts: z.coerce.number().int().min(0).max(9999).default(0),
  })).mutation(async ({ ctx, input }) => {
    if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Apenas a administração pode definir metas." });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const created = await db.insert(salesGoals).values({
      sellerId: input.sellerId,
      monthReference: new Date(`${input.monthReference}T12:00:00Z`),
      targetAmount: input.targetAmount.toFixed(2),
      targetContracts: input.targetContracts,
    }).$returningId();
    const id = created[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível definir a meta." });
    await recordAudit(ctx.user.id, "sales_goal", id, "created", `Meta comercial de ${input.monthReference} definida.`);
    return { id };
  }),
});
