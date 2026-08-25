import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, or } from "drizzle-orm";
import { z } from "zod";
import { customers, opportunities, proposalDiscountApprovals, proposals, salesCampaigns, salesGoals, salesPlaybooks, tasks, users } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, assertCapability, salesProcedure } from "./access";
import { resolveFollowUpAt } from "../domain";
import { buildSellerQualityRanking } from "../salesQuality";
import { saleStageFromFacts } from "../saleLifecycle";
import { canTransitionOpportunityStage } from "../../shared/opportunityLifecycle";

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
  playbooks: salesProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(salesPlaybooks).where(eq(salesPlaybooks.active, true)).orderBy(salesPlaybooks.stage, desc(salesPlaybooks.updatedAt)).limit(200);
  }),

  createPlaybook: adminProcedure.input(z.object({
    name: z.string().trim().min(3).max(180),
    stage: z.enum(["new", "qualified", "proposal", "negotiation", "won", "lost"]),
    guidance: z.string().trim().min(10).max(5000),
    checklist: z.string().trim().max(5000).optional().nullable(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const created = await db.insert(salesPlaybooks).values({ ...input, checklist: input.checklist || null, createdByUserId: ctx.user.id }).$returningId();
    const id = created[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível salvar o playbook." });
    await recordAudit(ctx.user.id, "sales_playbook", id, "created", `Playbook ${input.name} criado para a etapa ${input.stage}.`);
    await recordDomainEvent({ eventName: "sales.playbook.created", aggregateType: "sales_playbook", aggregateId: id, actorUserId: ctx.user.id, payload: { stage: input.stage, name: input.name } });
    return { id };
  }),

  createDiscountRequest: salesProcedure.input(z.object({ proposalId: z.number().int().positive(), requestedAmount: z.coerce.number().positive(), rationale: z.string().trim().min(10).max(3000) })).mutation(async ({ ctx, input }) => { assertCapability(ctx.user.role, "sales.discount.request");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const row = await db.select().from(proposals).where(eq(proposals.id, input.proposalId)).limit(1);
    const proposal = row[0];
    if (!proposal) throw new TRPCError({ code: "NOT_FOUND", message: "Proposta não encontrada." });
    const original = Number(proposal.totalAmount);
    if (input.requestedAmount >= original) throw new TRPCError({ code: "BAD_REQUEST", message: "O valor negociado precisa ser menor que o valor original." });
    const discountPercent = ((original - input.requestedAmount) / original) * 100;
    const created = await db.insert(proposalDiscountApprovals).values({ proposalId: input.proposalId, requestedByUserId: ctx.user.id, requestedAmount: input.requestedAmount.toFixed(2), discountPercent: discountPercent.toFixed(2), rationale: input.rationale }).$returningId();
    const id = created[0]?.id;
    await recordAudit(ctx.user.id, "proposal_discount", id ?? 0, "requested", `Desconto de ${discountPercent.toFixed(2)}% solicitado para proposta #${input.proposalId}.`);
    return { id, discountPercent };
  }),

  discountApprovals: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ approval: proposalDiscountApprovals, proposalReference: proposals.reference, requesterName: users.name }).from(proposalDiscountApprovals).innerJoin(proposals, eq(proposalDiscountApprovals.proposalId, proposals.id)).innerJoin(users, eq(proposalDiscountApprovals.requestedByUserId, users.id)).orderBy(desc(proposalDiscountApprovals.createdAt)).limit(500);
  }),

  decideDiscount: adminProcedure.input(z.object({ id: z.number().int().positive(), approve: z.boolean(), decisionNotes: z.string().trim().max(3000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.update(proposalDiscountApprovals).set({ status: input.approve ? "approved" : "rejected", decidedByUserId: ctx.user.id, decisionNotes: input.decisionNotes || null, decidedAt: new Date() }).where(eq(proposalDiscountApprovals.id, input.id));
    await recordAudit(ctx.user.id, "proposal_discount", input.id, input.approve ? "approved" : "rejected", "Pedido de desconto decidido pela administração.");
    return { success: true };
  }),

  pipeline: salesProcedure.input(z.object({ stage: z.enum(["new", "qualified", "proposal", "negotiation", "won", "lost"]).optional(), sellerId: z.number().int().positive().optional(), search: z.string().trim().max(120).optional(), limit: z.number().int().min(1).max(500).default(120) }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    const term = input?.search ? `%${input.search}%` : null;
    return db.select({ opportunity: opportunities, customerName: customers.fullName, sellerName: users.name })
      .from(opportunities)
      .innerJoin(customers, eq(opportunities.customerId, customers.id))
      .leftJoin(users, eq(opportunities.sellerId, users.id))
      .where(and(input?.stage ? eq(opportunities.stage, input.stage) : undefined, input?.sellerId ? eq(opportunities.sellerId, input.sellerId) : undefined, term ? or(like(opportunities.title, term), like(customers.fullName, term), like(opportunities.source, term)) : undefined))
      .orderBy(desc(opportunities.updatedAt)).limit(input?.limit ?? 120);
  }),

  qualityRanking: salesProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select({ sellerId: opportunities.sellerId, sellerName: users.name, stage: opportunities.stage, expectedAmount: opportunities.expectedAmount, nextFollowUpAt: opportunities.nextFollowUpAt }).from(opportunities).leftJoin(users, eq(opportunities.sellerId, users.id)).orderBy(desc(opportunities.updatedAt)).limit(1000);
    return buildSellerQualityRanking(rows);
  }),

  createOpportunity: salesProcedure.input(opportunityInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const customer = (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente da oportunidade não encontrado." });
    const sellerId = input.sellerId ?? ctx.user.id;
    const seller = (await db.select({ id: users.id }).from(users).where(eq(users.id, sellerId)).limit(1))[0];
    if (!seller) throw new TRPCError({ code: "NOT_FOUND", message: "Vendedor da oportunidade não encontrado." });
    if (input.campaignId) {
      const campaign = (await db.select({ id: salesCampaigns.id }).from(salesCampaigns).where(eq(salesCampaigns.id, input.campaignId)).limit(1))[0];
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campanha da oportunidade não encontrada." });
    }
    const followUpAt = resolveFollowUpAt(input.nextFollowUpAt);
    const result = await db.insert(opportunities).values({
      ...input,
      sellerId,
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
      assignedToUserId: sellerId,
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
    const previous = (await db.select({ stage: opportunities.stage }).from(opportunities).where(eq(opportunities.id, input.id)).limit(1))[0];
    if (!previous) throw new TRPCError({ code: "NOT_FOUND", message: "Oportunidade não encontrada." });
    if (!canTransitionOpportunityStage(previous.stage, input.data.stage)) throw new TRPCError({ code: "CONFLICT", message: `Transição de oportunidade inválida: ${previous.stage} → ${input.data.stage}.` });
    await db.update(opportunities).set({
      ...input.data,
      expectedAmount: input.data.expectedAmount.toFixed(2),
      source: input.data.source?.trim() || null,
      nextFollowUpAt: input.data.nextFollowUpAt ? new Date(input.data.nextFollowUpAt) : null,
      lossReason: input.data.lossReason?.trim() || null,
      closedAt: input.data.stage === "won" || input.data.stage === "lost" ? new Date() : null,
    }).where(eq(opportunities.id, input.id));
    await recordAudit(ctx.user.id, "opportunity", input.id, "updated", `Oportunidade atualizada para ${input.data.stage}.`);
    await recordDomainEvent({ eventName: "opportunity.updated", aggregateType: "opportunity", aggregateId: input.id, actorUserId: ctx.user.id, payload: { campaignId: input.data.campaignId ?? null, previousStage: previous.stage, stage: input.data.stage, expectedAmount: input.data.expectedAmount } });
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
    assertCapability(ctx.user.role, "sales.proposal.create");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const opportunity = (await db.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.id, input.opportunityId)).limit(1))[0];
    if (!opportunity) throw new TRPCError({ code: "NOT_FOUND", message: "Oportunidade da proposta não encontrada." });
    const result = await db.insert(proposals).values({
      ...input,
      totalAmount: input.totalAmount.toFixed(2),
      downPaymentAmount: input.downPaymentAmount.toFixed(2),
      expiresAt: input.expiresAt ? new Date(`${input.expiresAt}T12:00:00Z`) : null,
    }).$returningId();
    const id = result[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a proposta." });
    await db.update(opportunities).set({ stage: "proposal", updatedAt: new Date() }).where(eq(opportunities.id, input.opportunityId));
    await recordAudit(ctx.user.id, "proposal", id, "created", `Proposta ${input.reference} criada.`);
    await recordDomainEvent({ eventName: input.status === "approved" ? "proposal.accepted" : "proposal.created", aggregateType: "proposal", aggregateId: id, actorUserId: ctx.user.id, payload: { opportunityId: input.opportunityId, status: input.status, totalAmount: input.totalAmount, saleTruthStage: saleStageFromFacts({ proposalAccepted: input.status === "approved" }) } });
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
      db.select({ goal: salesGoals, sellerName: users.name }).from(salesGoals).innerJoin(users, eq(salesGoals.sellerId, users.id)).orderBy(desc(salesGoals.monthReference)).limit(1000),
      db.select().from(opportunities).where(eq(opportunities.stage, "won")).limit(5000),
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
