import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, contractCancellationRequests, contracts, installments, opportunities, proposals, salesCampaigns, salesCommissions, salesGoals, users } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { calculateCommission } from "../commissionDomain";
import { calculateCampaignProgress } from "../campaignProgress";
import { borderoSummary, type CommissionStatus } from "../commissionLifecycle";
import { router } from "../_core/trpc";
import { adminProcedure, assertCapability, commissionsProcedure, financeProcedure } from "./access";
import { buildProfessionalScorecards, type ProfessionalSaleFact } from "../professionalScorecard";
import { syncRevenueQualityForContract } from "../revenueQualitySync";

const campaignInput = z.object({ name: z.string().min(3).max(180), code: z.string().min(2).max(64).transform(value => value.trim().toUpperCase().replace(/\s+/g, "-")), description: z.string().max(2000).optional(), startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), commissionRate: z.coerce.number().min(0).max(100), targetAmount: z.coerce.number().min(0).default(0), status: z.enum(["draft", "active", "closed"]).default("draft") });

export const commissionsRouter = router({
  scorecards: commissionsProcedure.input(z.object({ minimumMaturedSales: z.number().int().min(1).max(100).default(10) }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return { rolesCovered: [], scorecards: [] };
    const [contractRows, proposalRows, opportunityRows, captureRows, installmentRows, cancellationRows, userRows] = await Promise.all([
      db.select().from(contracts).limit(5000), db.select().from(proposals).limit(5000), db.select().from(opportunities).limit(5000), db.select().from(captureRecords).limit(10_000), db.select().from(installments).limit(20_000), db.select().from(contractCancellationRequests).limit(2000), db.select({ id: users.id, name: users.name, email: users.email }).from(users).limit(1000),
    ]);
    const proposalById = new Map(proposalRows.map(row => [row.id, row]));
    const opportunityById = new Map(opportunityRows.map(row => [row.id, row]));
    const capturesByOpportunity = new Map<number, typeof captureRows>();
    captureRows.forEach(capture => { if (!capture.opportunityId) return; const rows = capturesByOpportunity.get(capture.opportunityId) ?? []; rows.push(capture); capturesByOpportunity.set(capture.opportunityId, rows); });
    const cancellationByContract = new Map(cancellationRows.filter(row => row.status === "executed").map(row => [row.contractId, row]));
    const facts: ProfessionalSaleFact[] = contractRows.flatMap<ProfessionalSaleFact>(contract => {
      const proposal = contract.proposalId ? proposalById.get(contract.proposalId) : undefined;
      const opportunity = proposal ? opportunityById.get(proposal.opportunityId) : undefined;
      const capture = opportunity ? (capturesByOpportunity.get(opportunity.id) ?? []).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] : undefined;
      if (!capture) return [];
      const cashConfirmed = installmentRows.filter(row => row.contractId === contract.id && row.status === "paid").reduce((sum, row) => sum + Number(row.amount), 0);
      const lifecycle = cancellationByContract.has(contract.id) || contract.status === "cancelled" ? "cancelled" : cashConfirmed > 0 ? "matured" : "new";
      const sale = { saleId: contract.id, vgvFormalized: Number(contract.totalAmount), cashConfirmed, lifecycle } as const;
      const promoterAssignments = capture.promoterId ? [{ ...sale, userId: capture.promoterId, role: "promoter" as const }] : [];
      const qualifierAssignments = capture.qualifierId ? [{ ...sale, userId: capture.qualifierId, role: "qualifier" as const }] : [];
      const roomManagerAssignments = capture.roomManagerId ? [{ ...sale, userId: capture.roomManagerId, role: "room_manager" as const }] : [];
      if (capture.linerId && capture.closerId && capture.linerId === capture.closerId) return [...promoterAssignments, ...qualifierAssignments, ...roomManagerAssignments, { ...sale, userId: capture.linerId, role: "ftb" as const }];
      return [
        ...promoterAssignments,
        ...qualifierAssignments,
        ...roomManagerAssignments,
        ...(capture.linerId ? [{ ...sale, userId: capture.linerId, role: "liner" as const }] : []),
        ...(capture.closerId ? [{ ...sale, userId: capture.closerId, role: "closer" as const }] : []),
      ];
    });
    const names = new Map(userRows.map(row => [row.id, row.name || row.email || `Usuário #${row.id}`]));
    const scorecards = buildProfessionalScorecards(facts, input?.minimumMaturedSales ?? 10).filter(card => ctx.user.role !== "seller" || card.userId === ctx.user.id).map(card => ({ ...card, userName: names.get(card.userId) || `Usuário #${card.userId}` }));
    return { rolesCovered: ["promoter", "qualifier", "liner", "closer", "ftb", "room_manager"], scorecards };
  }),

  overview: commissionsProcedure.input(z.object({ campaignId: z.number().int().positive().optional(), sellerId: z.number().int().positive().optional(), closingMonth: z.string().regex(/^\d{4}-\d{2}$/).optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) return { campaigns: [], ranking: [], entries: [] };
    const sellerId = ctx.user.role === "seller" ? ctx.user.id : input?.sellerId;
    const [campaigns, opportunityRows, commissionRows, sellerRows, goalRows] = await Promise.all([
      db.select().from(salesCampaigns).limit(1000),
      db.select({ opportunity: opportunities, sellerName: users.name, sellerEmail: users.email, campaignName: salesCampaigns.name, campaignCode: salesCampaigns.code }).from(opportunities).leftJoin(users, eq(opportunities.sellerId, users.id)).leftJoin(salesCampaigns, eq(opportunities.campaignId, salesCampaigns.id)).limit(5000),
      db.select({ commission: salesCommissions, sellerName: users.name, campaignName: salesCampaigns.name, campaignCode: salesCampaigns.code }).from(salesCommissions).leftJoin(users, eq(salesCommissions.sellerId, users.id)).leftJoin(salesCampaigns, eq(salesCommissions.campaignId, salesCampaigns.id)).limit(5000),
      db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.role, "seller")).limit(1000),
      db.select().from(salesGoals).limit(1000),
    ]);
    const selectedOpportunities = opportunityRows.filter(row => row.opportunity.stage === "won" && (!input?.campaignId || row.opportunity.campaignId === input.campaignId) && (!sellerId || row.opportunity.sellerId === sellerId));
    const selectedCommissions = commissionRows.filter(row => (!input?.campaignId || row.commission.campaignId === input.campaignId) && (!sellerId || row.commission.sellerId === sellerId) && (!input?.closingMonth || (row.commission.closingAt ?? row.commission.createdAt).toISOString().slice(0, 7) === input.closingMonth));
    const rank = new Map<number, { sellerId: number; sellerName: string; salesAmount: number; wonCount: number; commissionAmount: number; pendingAmount: number; paidAmount: number }>();
    selectedOpportunities.forEach(row => { if (!row.opportunity.sellerId) return; const item = rank.get(row.opportunity.sellerId) ?? { sellerId: row.opportunity.sellerId, sellerName: row.sellerName || row.sellerEmail || "Sem vendedor", salesAmount: 0, wonCount: 0, commissionAmount: 0, pendingAmount: 0, paidAmount: 0 }; item.salesAmount += Number(row.opportunity.expectedAmount); item.wonCount += 1; rank.set(item.sellerId, item); });
    selectedCommissions.forEach(row => { const item = rank.get(row.commission.sellerId) ?? { sellerId: row.commission.sellerId, sellerName: row.sellerName || "Vendedor", salesAmount: 0, wonCount: 0, commissionAmount: 0, pendingAmount: 0, paidAmount: 0 }; const value = Number(row.commission.amount); if (row.commission.status !== "cancelled") item.commissionAmount += value; if (row.commission.status === "pending" || row.commission.status === "approved") item.pendingAmount += value; if (row.commission.status === "paid") item.paidAmount += value; rank.set(item.sellerId, item); });
    const ranking = Array.from(rank.values()).sort((a, b) => b.salesAmount - a.salesAmount).map((item, index) => ({ ...item, position: index + 1 }));
    const entries = selectedCommissions.sort((a, b) => b.commission.createdAt.getTime() - a.commission.createdAt.getTime()); const bordero = borderoSummary(entries.map(row => ({ amount: Number(row.commission.amount), expectedPaymentAt: row.commission.expectedPaymentAt ?? row.commission.createdAt, status: (row.commission.status === "paid" ? "paid" : row.commission.status === "cancelled" ? "cancelled" : row.commission.lifecycleStatus) as CommissionStatus })));
    return { campaigns: campaigns.map(campaign => { const salesAmount = selectedOpportunities.filter(item => item.opportunity.campaignId === campaign.id).reduce((sum, item) => sum + Number(item.opportunity.expectedAmount), 0); return { ...campaign, ...calculateCampaignProgress(Number(campaign.targetAmount), salesAmount) }; }), sellers: sellerRows.map(item => ({ id: item.id, name: item.name || item.email || "Vendedor" })), ranking, goals: goalRows.map(goal => { const currentAmount = ranking.find(item => item.sellerId === goal.sellerId)?.salesAmount ?? 0; return { sellerId: goal.sellerId, targetAmount: Number(goal.targetAmount), currentAmount, progress: Number(goal.targetAmount) ? Math.min(100, currentAmount / Number(goal.targetAmount) * 100) : 0 }; }), entries, bordero };
  }),
  createCampaign: adminProcedure.input(campaignInput).mutation(async ({ ctx, input }) => { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); const created = await db.insert(salesCampaigns).values({ ...input, startsAt: input.startsAt ? new Date(`${input.startsAt}T12:00:00Z`) : null, endsAt: input.endsAt ? new Date(`${input.endsAt}T12:00:00Z`) : null, commissionRate: input.commissionRate.toFixed(2), targetAmount: input.targetAmount.toFixed(2) }).$returningId(); const id = created[0]?.id; if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a campanha." }); await recordAudit(ctx.user.id, "sales_campaign", id, "created", `Campanha ${input.code} criada com meta de R$ ${input.targetAmount.toFixed(2)} e comissão de ${input.commissionRate}%.`); return { id }; }),
  record: financeProcedure.input(z.object({ sellerId: z.number().int().positive(), campaignId: z.number().int().positive().optional(), opportunityId: z.number().int().positive().optional(), contractId: z.number().int().positive().optional(), baseAmount: z.coerce.number().positive(), rate: z.coerce.number().min(0).max(100), notes: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => { assertCapability(ctx.user.role, "commission.pay"); const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); const amount = calculateCommission(input.baseAmount, input.rate); const created = await db.insert(salesCommissions).values({ sellerId: input.sellerId, campaignId: input.campaignId ?? null, opportunityId: input.opportunityId ?? null, contractId: input.contractId ?? null, baseAmount: input.baseAmount.toFixed(2), rate: input.rate.toFixed(2), amount: amount.toFixed(2), notes: input.notes ?? null }).$returningId(); const id = created[0]?.id; if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar a comissão." }); await recordAudit(ctx.user.id, "sales_commission", id, "created", `Comissão de ${amount.toFixed(2)} lançada.`); if (input.contractId) await syncRevenueQualityForContract({ contractId: input.contractId, actorUserId: ctx.user.id, trigger: "lançamento manual de comissão vinculada" }); return { id, amount }; }),
  setStatus: financeProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["approved", "paid", "cancelled"]) })).mutation(async ({ ctx, input }) => { assertCapability(ctx.user.role, "commission.pay"); const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); const commission = (await db.select({ contractId: salesCommissions.contractId }).from(salesCommissions).where(eq(salesCommissions.id, input.id)).limit(1))[0]; await db.update(salesCommissions).set({ status: input.status, approvedAt: input.status === "approved" ? new Date() : undefined, paidAt: input.status === "paid" ? new Date() : undefined }).where(eq(salesCommissions.id, input.id)); await recordAudit(ctx.user.id, "sales_commission", input.id, input.status, `Comissão marcada como ${input.status}.`); if (commission?.contractId) await syncRevenueQualityForContract({ contractId: commission.contractId, actorUserId: ctx.user.id, trigger: `status de comissão manual: ${input.status}` }); return { success: true }; }),
});
