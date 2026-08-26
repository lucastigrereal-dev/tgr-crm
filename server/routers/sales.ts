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
    const requested = await db.transaction(async tx => {
      const proposal = (await tx.select().from(proposals).where(eq(proposals.id, input.proposalId)).limit(1).for("update"))[0];
      if (!proposal) throw new TRPCError({ code: "NOT_FOUND", message: "Proposta não encontrada." });
      const original = Number(proposal.totalAmount);
      if (input.requestedAmount >= original) throw new TRPCError({ code: "BAD_REQUEST", message: "O valor negociado precisa ser menor que o valor original." });
      const pending = (await tx.select({ id: proposalDiscountApprovals.id }).from(proposalDiscountApprovals).where(and(eq(proposalDiscountApprovals.proposalId, input.proposalId), eq(proposalDiscountApprovals.status, "pending"))).limit(1))[0];
      if (pending) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma solicitação de desconto pendente para esta proposta." });
      const discountPercent = ((original - input.requestedAmount) / original) * 100;
      const created = await tx.insert(proposalDiscountApprovals).values({ proposalId: input.proposalId, requestedByUserId: ctx.user.id, requestedAmount: input.requestedAmount.toFixed(2), discountPercent: discountPercent.toFixed(2), rationale: input.rationale }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível solicitar o desconto." });
      return { id, discountPercent };
    });
    await recordAudit(ctx.user.id, "proposal_discount", requested.id, "requested", `Desconto de ${requested.discountPercent.toFixed(2)}% solicitado para proposta #${input.proposalId}.`);
    return requested;
  }),

  discountApprovals: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 500;
    const rawRows = await db.select({ approval: proposalDiscountApprovals, proposalReference: proposals.reference, requesterName: users.name }).from(proposalDiscountApprovals).innerJoin(proposals, eq(proposalDiscountApprovals.proposalId, proposals.id)).innerJoin(users, eq(proposalDiscountApprovals.requestedByUserId, users.id)).orderBy(desc(proposalDiscountApprovals.createdAt)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["pedidos de desconto"] : [] };
  }),

  decideDiscount: adminProcedure.input(z.object({ id: z.number().int().positive(), approve: z.boolean(), decisionNotes: z.string().trim().max(3000).optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const existing = (await db.select({ status: proposalDiscountApprovals.status, requestedAmount: proposalDiscountApprovals.requestedAmount }).from(proposalDiscountApprovals).where(eq(proposalDiscountApprovals.id, input.id)).limit(1))[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido de desconto não encontrado." });
    if (existing.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: "Este pedido de desconto já foi decidido." });
    const updateResult = await db.update(proposalDiscountApprovals).set({ status: input.approve ? "approved" : "rejected", approvedAmount: input.approve ? existing.requestedAmount : null, decidedByUserId: ctx.user.id, decisionNotes: input.decisionNotes || null, decidedAt: new Date() }).where(and(eq(proposalDiscountApprovals.id, input.id), eq(proposalDiscountApprovals.status, "pending")));
    if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "O pedido de desconto foi alterado por outra operação." });
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
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 1000;
    const rawRows = await db.select({ sellerId: opportunities.sellerId, sellerName: users.name, stage: opportunities.stage, expectedAmount: opportunities.expectedAmount, nextFollowUpAt: opportunities.nextFollowUpAt }).from(opportunities).leftJoin(users, eq(opportunities.sellerId, users.id)).orderBy(desc(opportunities.updatedAt)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: buildSellerQualityRanking(rawRows.slice(0, limit)), truncated, truncatedSources: truncated ? ["oportunidades do ranking"] : [] };
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
    const id = await db.transaction(async tx => {
      const result = await tx.insert(opportunities).values({
        ...input,
        sellerId,
        expectedAmount: input.expectedAmount.toFixed(2),
        source: input.source?.trim() || null,
        nextFollowUpAt: followUpAt,
        lossReason: input.lossReason?.trim() || null,
        closedAt: input.stage === "won" || input.stage === "lost" ? new Date() : null,
      }).$returningId();
      const opportunityId = result[0]?.id;
      if (!opportunityId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a oportunidade." });
      await tx.insert(tasks).values({
        title: `Follow-up comercial: ${input.title}`,
        description: `Follow-up automático criado com a oportunidade comercial #${opportunityId}.`,
        type: "follow_up",
        priority: "normal",
        customerId: input.customerId,
        assignedToUserId: sellerId,
        dueAt: followUpAt,
        reminderAt: followUpAt,
        createdByUserId: ctx.user.id,
      });
      return opportunityId;
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
    const customer = (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.data.customerId)).limit(1))[0];
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente da oportunidade não encontrado." });
    if (input.data.sellerId !== null && input.data.sellerId !== undefined) {
      const seller = (await db.select({ id: users.id }).from(users).where(eq(users.id, input.data.sellerId)).limit(1))[0];
      if (!seller) throw new TRPCError({ code: "NOT_FOUND", message: "Vendedor da oportunidade não encontrado." });
    }
    if (input.data.campaignId !== null && input.data.campaignId !== undefined) {
      const campaign = (await db.select({ id: salesCampaigns.id }).from(salesCampaigns).where(eq(salesCampaigns.id, input.data.campaignId)).limit(1))[0];
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campanha da oportunidade não encontrada." });
    }
    const updateResult = await db.update(opportunities).set({
      ...input.data,
      expectedAmount: input.data.expectedAmount.toFixed(2),
      source: input.data.source?.trim() || null,
      nextFollowUpAt: input.data.nextFollowUpAt ? new Date(input.data.nextFollowUpAt) : null,
      lossReason: input.data.lossReason?.trim() || null,
      closedAt: input.data.stage === "won" || input.data.stage === "lost" ? new Date() : null,
    }).where(and(eq(opportunities.id, input.id), eq(opportunities.stage, previous.stage)));
    if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "A oportunidade foi alterada por outra operação. Recarregue e tente novamente." });
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
    const id = await db.transaction(async tx => {
      const opportunity = (await tx.select({ id: opportunities.id, stage: opportunities.stage }).from(opportunities).where(eq(opportunities.id, input.opportunityId)).limit(1).for("update"))[0];
      if (!opportunity) throw new TRPCError({ code: "NOT_FOUND", message: "Oportunidade da proposta não encontrada." });
      if (!canTransitionOpportunityStage(opportunity.stage, "proposal")) throw new TRPCError({ code: "CONFLICT", message: `Não é possível criar proposta para oportunidade em estágio ${opportunity.stage}.` });
      const duplicate = (await tx.select({ id: proposals.id }).from(proposals).where(eq(proposals.reference, input.reference)).limit(1))[0];
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma proposta com esta referência." });
      const result = await tx.insert(proposals).values({
        ...input,
        totalAmount: input.totalAmount.toFixed(2),
        downPaymentAmount: input.downPaymentAmount.toFixed(2),
        expiresAt: input.expiresAt ? new Date(`${input.expiresAt}T12:00:00Z`) : null,
      }).$returningId();
      const proposalId = result[0]?.id;
      if (!proposalId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a proposta." });
      const stageUpdate = await tx.update(opportunities).set({ stage: "proposal", updatedAt: new Date() }).where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.stage, opportunity.stage)));
      if (stageUpdate && typeof stageUpdate === "object" && "affectedRows" in stageUpdate && Number(stageUpdate.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "A oportunidade foi alterada por outra operação. Recarregue e tente novamente." });
      return proposalId;
    });
    await recordAudit(ctx.user.id, "proposal", id, "created", `Proposta ${input.reference} criada.`);
    await recordDomainEvent({ eventName: input.status === "approved" ? "proposal.accepted" : "proposal.created", aggregateType: "proposal", aggregateId: id, actorUserId: ctx.user.id, payload: { opportunityId: input.opportunityId, status: input.status, totalAmount: input.totalAmount, saleTruthStage: saleStageFromFacts({ proposalAccepted: input.status === "approved" }) } });
    return { id };
  }),

  proposals: salesProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 100;
    const rawRows = await db.select({ proposal: proposals, opportunityTitle: opportunities.title, customerName: customers.fullName })
      .from(proposals)
      .innerJoin(opportunities, eq(proposals.opportunityId, opportunities.id))
      .innerJoin(customers, eq(opportunities.customerId, customers.id))
      .orderBy(desc(proposals.updatedAt)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["propostas"] : [] };
  }),

  goals: salesProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const sellerId = ctx.user.role === "seller" ? ctx.user.id : undefined;
    const [goalRows, wonOpportunities] = await Promise.all([
      db.select({ goal: salesGoals, sellerName: users.name }).from(salesGoals).innerJoin(users, eq(salesGoals.sellerId, users.id)).where(sellerId ? eq(salesGoals.sellerId, sellerId) : undefined).orderBy(desc(salesGoals.monthReference)).limit(1000),
      db.select().from(opportunities).where(and(eq(opportunities.stage, "won"), sellerId ? eq(opportunities.sellerId, sellerId) : undefined)).limit(5000),
    ]);
    const progressBySellerMonth = new Map<string, { currentAmount: number; currentContracts: number }>();
    for (const opportunity of wonOpportunities) {
      if (opportunity.sellerId === null || !opportunity.closedAt) continue;
      const closeDate = new Date(opportunity.closedAt);
      const key = `${opportunity.sellerId}:${closeDate.getUTCFullYear()}-${closeDate.getUTCMonth()}`;
      const progress = progressBySellerMonth.get(key) ?? { currentAmount: 0, currentContracts: 0 };
      progress.currentAmount += Number(opportunity.expectedAmount);
      progress.currentContracts += 1;
      progressBySellerMonth.set(key, progress);
    }
    const truncatedSources = [
      goalRows.length >= 1_000 ? "metas" : null,
      wonOpportunities.length >= 5_000 ? "oportunidades ganhas" : null,
    ].filter((source): source is string => Boolean(source));
    const rows = goalRows.map(row => {
      const reference = new Date(row.goal.monthReference);
      const key = `${row.goal.sellerId}:${reference.getUTCFullYear()}-${reference.getUTCMonth()}`;
      const progress = progressBySellerMonth.get(key) ?? { currentAmount: 0, currentContracts: 0 };
      return { ...row, ...progress };
    });
    return { rows, truncated: truncatedSources.length > 0, truncatedSources };
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
    const seller = (await db.select({ id: users.id }).from(users).where(eq(users.id, input.sellerId)).limit(1))[0];
    if (!seller) throw new TRPCError({ code: "NOT_FOUND", message: "Vendedor da meta não encontrado." });
    const monthReference = new Date(`${input.monthReference}T12:00:00Z`);
    const duplicate = (await db.select({ id: salesGoals.id }).from(salesGoals).where(and(eq(salesGoals.sellerId, input.sellerId), eq(salesGoals.monthReference, monthReference))).limit(1))[0];
    if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma meta para este vendedor nesse mês." });
    const created = await db.insert(salesGoals).values({
      sellerId: input.sellerId,
      monthReference,
      targetAmount: input.targetAmount.toFixed(2),
      targetContracts: input.targetContracts,
    }).$returningId();
    const id = created[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível definir a meta." });
    await recordAudit(ctx.user.id, "sales_goal", id, "created", `Meta comercial de ${input.monthReference} definida.`);
    return { id };
  }),
});
