import { and, eq, lte, gte } from "drizzle-orm";
import { ownershipEntitlements, unitMaintenanceBlocks } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { contractsProcedure, serviceProcedure } from "./access";
import { z } from "zod";

export const ownershipRouter = router({
  listEntitlements: contractsProcedure.input(z.object({ contractId: z.number().optional() }).optional()).query(async ({ input }) => {
    const db = await getDb(); if (!db) return [];
    return input?.contractId ? db.select().from(ownershipEntitlements).where(eq(ownershipEntitlements.contractId, input.contractId)) : db.select().from(ownershipEntitlements);
  }),
  createEntitlement: contractsProcedure.input(z.object({ contractId: z.number(), resortId: z.number().nullable().optional(), unitId: z.number().nullable().optional(), entitlementType: z.enum(["fixed_week", "flexible_week", "points", "exchange"]), fixedWeek: z.number().int().min(1).max(53).nullable().optional(), annualPoints: z.number().int().min(0).default(0), priorityLevel: z.number().int().min(1).max(9).default(1), validFrom: z.string().nullable().optional(), validUntil: z.string().nullable().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new Error("Banco indisponível");
    if (input.entitlementType === "fixed_week" && !input.fixedWeek) throw new Error("Semana fixa é obrigatória para este direito.");
    const [created] = await db.insert(ownershipEntitlements).values({ contractId: input.contractId, resortId: input.resortId ?? null, unitId: input.unitId ?? null, entitlementType: input.entitlementType, fixedWeek: input.fixedWeek ?? null, annualPoints: input.annualPoints, priorityLevel: input.priorityLevel, validFrom: input.validFrom ? new Date(input.validFrom) : null, validUntil: input.validUntil ? new Date(input.validUntil) : null }).$returningId();
    await recordAudit(ctx.user.id, "ownership_entitlement", created.id, "created", `Direito ${input.entitlementType} criado.`);
    await recordDomainEvent({ eventName: "ownership.entitlement.created", aggregateType: "ownership_entitlement", aggregateId: created.id, actorUserId: ctx.user.id, payload: { contractId: input.contractId, entitlementType: input.entitlementType } });
    return created;
  }),
  createMaintenanceBlock: serviceProcedure.input(z.object({ unitId: z.number(), startsAt: z.string(), endsAt: z.string(), reason: z.string().min(3).max(255) })).mutation(async ({ ctx, input }) => {
    if (input.endsAt <= input.startsAt) throw new Error("Fim da manutenção precisa ser posterior ao início.");
    const db = await getDb(); if (!db) throw new Error("Banco indisponível");
    const conflicts = await db.select().from(unitMaintenanceBlocks).where(and(eq(unitMaintenanceBlocks.unitId, input.unitId), lte(unitMaintenanceBlocks.startsAt, new Date(input.endsAt)), gte(unitMaintenanceBlocks.endsAt, new Date(input.startsAt))));
    if (conflicts.some(item => item.status !== "cancelled" && item.status !== "completed")) throw new Error("Já existe bloqueio operacional neste período.");
    const [created] = await db.insert(unitMaintenanceBlocks).values({ unitId: input.unitId, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), reason: input.reason, createdByUserId: ctx.user.id }).$returningId();
    await recordDomainEvent({ eventName: "unit.maintenance.blocked", aggregateType: "unit_maintenance_block", aggregateId: created.id, actorUserId: ctx.user.id, payload: input }); return created;
  }),
});
