import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { contractCancellationRequests, contractDocuments, contracts, customerInteractions, installments, opportunities, proposals, tasks } from "../../drizzle/schema";
import { getDb } from "../db";
import { calculateSaleHealth } from "../../shared/saleHealthScore";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { internalProcedure } from "./access";

export const intelligenceRouter = router({
  portfolioHealth: internalProcedure.input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return { generatedAt: new Date(), truncated: false, summary: { total: 0, healthy: 0, attention: 0, critical: 0 }, rows: [] };

    const limit = input?.limit ?? 100;
    const contractRows = await db.select().from(contracts).orderBy(desc(contracts.updatedAt)).limit(limit + 1);
    const truncated = contractRows.length > limit;
    const selectedContracts = contractRows.slice(0, limit);
    const contractIds = selectedContracts.map(contract => contract.id);
    const customerIds = selectedContracts.map(contract => contract.customerId);
    const proposalIds = selectedContracts.flatMap(contract => contract.proposalId ? [contract.proposalId] : []);

    if (!contractIds.length) return { generatedAt: new Date(), truncated, summary: { total: 0, healthy: 0, attention: 0, critical: 0 }, rows: [] };

    const [installmentRows, documentRows, taskRows, cancellationRows, interactionRows, proposalRows] = await Promise.all([
      db.select().from(installments).where(inArray(installments.contractId, contractIds)),
      db.select({ id: contractDocuments.id, contractId: contractDocuments.contractId }).from(contractDocuments).where(inArray(contractDocuments.contractId, contractIds)),
      db.select({ id: tasks.id, contractId: tasks.contractId, status: tasks.status, type: tasks.type }).from(tasks).where(inArray(tasks.contractId, contractIds)),
      db.select({ id: contractCancellationRequests.id, contractId: contractCancellationRequests.contractId, status: contractCancellationRequests.status }).from(contractCancellationRequests).where(and(inArray(contractCancellationRequests.contractId, contractIds), inArray(contractCancellationRequests.status, ["requested", "approved"]))),
      customerIds.length ? db.select({ customerId: customerInteractions.customerId, occurredAt: customerInteractions.occurredAt }).from(customerInteractions).where(inArray(customerInteractions.customerId, customerIds)).orderBy(desc(customerInteractions.occurredAt)) : Promise.resolve([]),
      proposalIds.length ? db.select().from(proposals).where(inArray(proposals.id, proposalIds)) : Promise.resolve([]),
    ]);

    const opportunityIds = proposalRows.map(proposal => proposal.opportunityId);
    const opportunityRows = opportunityIds.length ? await db.select({ id: opportunities.id, stage: opportunities.stage }).from(opportunities).where(inArray(opportunities.id, opportunityIds)) : [];
    const proposalById = new Map(proposalRows.map(proposal => [proposal.id, proposal]));
    const opportunityById = new Map(opportunityRows.map(opportunity => [opportunity.id, opportunity]));
    const installmentsByContract = new Map<number, typeof installmentRows>();
    const documentsByContract = new Map<number, number>();
    const tasksByContract = new Map<number, number>();
    const cancellationsByContract = new Set<number>();
    const latestInteractionByCustomer = new Map<number, Date>();

    for (const row of installmentRows) installmentsByContract.set(row.contractId, [...(installmentsByContract.get(row.contractId) ?? []), row]);
    for (const row of documentRows) documentsByContract.set(row.contractId, (documentsByContract.get(row.contractId) ?? 0) + 1);
    for (const row of taskRows) if (row.status === "open" || row.status === "in_progress") tasksByContract.set(row.contractId ?? 0, (tasksByContract.get(row.contractId ?? 0) ?? 0) + 1);
    for (const row of cancellationRows) cancellationsByContract.add(row.contractId);
    for (const row of interactionRows) if (!latestInteractionByCustomer.has(row.customerId)) latestInteractionByCustomer.set(row.customerId, row.occurredAt);

    const now = Date.now();
    const rows = selectedContracts.map(contract => {
      const installmentsForContract = installmentsByContract.get(contract.id) ?? [];
      const proposal = contract.proposalId ? proposalById.get(contract.proposalId) : undefined;
      const opportunity = proposal ? opportunityById.get(proposal.opportunityId) : undefined;
      const latestInteraction = latestInteractionByCustomer.get(contract.customerId);
      const daysSinceLastInteraction = latestInteraction ? Math.max(0, Math.floor((now - latestInteraction.getTime()) / 86_400_000)) : null;
      const health = calculateSaleHealth({
        commercialStage: opportunity?.stage ?? "new",
        contractStatus: contract.status,
        paidInstallments: installmentsForContract.filter(item => item.status === "paid").length,
        overdueInstallments: installmentsForContract.filter(item => item.status === "overdue").length,
        totalInstallments: installmentsForContract.length,
        documentCount: documentsByContract.get(contract.id) ?? 0,
        requiredDocumentCount: 0,
        daysSinceLastInteraction,
        openFollowUps: tasksByContract.get(contract.id) ?? 0,
        cancellationRequested: cancellationsByContract.has(contract.id),
      });
      return { contractId: contract.id, customerId: contract.customerId, contractNumber: contract.number, status: contract.status, health };
    }).sort((left, right) => left.health.score - right.health.score);

    return {
      generatedAt: new Date(),
      truncated,
      summary: {
        total: rows.length,
        healthy: rows.filter(row => row.health.band === "healthy").length,
        attention: rows.filter(row => row.health.band === "attention").length,
        critical: rows.filter(row => row.health.band === "critical").length,
      },
      rows,
    };
  }),
});
