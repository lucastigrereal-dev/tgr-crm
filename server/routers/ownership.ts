import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { contracts, ownershipEntitlements, resorts, unitMaintenanceBlocks, units } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { contractsProcedure, serviceProcedure } from "./access";
import { z } from "zod";

export const ownershipRouter = router({
  listEntitlements: contractsProcedure.input(z.object({ contractId: z.number().int().positive().optional() }).optional()).query(async ({ input }) => {
    const db = await getDb(); if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 1000;
    const rawRows = input?.contractId
      ? await db.select().from(ownershipEntitlements).where(eq(ownershipEntitlements.contractId, input.contractId)).limit(limit + 1)
      : await db.select().from(ownershipEntitlements).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["direitos de uso"] : [] };
  }),
  listMaintenanceBlocks: serviceProcedure.query(async () => {
    const db = await getDb(); if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 100;
    const rawRows = await db.select({ block: unitMaintenanceBlocks, unitCode: units.code, resortName: resorts.name })
      .from(unitMaintenanceBlocks)
      .innerJoin(units, eq(unitMaintenanceBlocks.unitId, units.id))
      .innerJoin(resorts, eq(units.resortId, resorts.id))
      .orderBy(desc(unitMaintenanceBlocks.startsAt)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["bloqueios de manutenção"] : [] };
  }),
  createEntitlement: contractsProcedure.input(z.object({ contractId: z.number().int().positive(), resortId: z.number().int().positive().nullable().optional(), unitId: z.number().int().positive().nullable().optional(), entitlementType: z.enum(["fixed_week", "flexible_week", "points", "exchange"]), fixedWeek: z.number().int().min(1).max(53).nullable().optional(), annualPoints: z.number().int().min(0).default(0), priorityLevel: z.number().int().min(1).max(9).default(1), validFrom: z.string().nullable().optional(), validUntil: z.string().nullable().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    if (input.entitlementType === "fixed_week" && !input.fixedWeek) throw new TRPCError({ code: "BAD_REQUEST", message: "Semana fixa é obrigatória para este direito." });
    const validFrom = input.validFrom ? new Date(input.validFrom) : null;
    const validUntil = input.validUntil ? new Date(input.validUntil) : null;
    if ((validFrom && Number.isNaN(validFrom.getTime())) || (validUntil && Number.isNaN(validUntil.getTime()))) throw new TRPCError({ code: "BAD_REQUEST", message: "Período de vigência inválido." });
    if (validFrom && validUntil && validUntil <= validFrom) throw new TRPCError({ code: "BAD_REQUEST", message: "O fim da vigência precisa ser posterior ao início." });
    const contract = (await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1))[0];
    if (!contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato do direito não encontrado." });
    if (input.resortId) {
      const resort = (await db.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1))[0];
      if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento do direito não encontrado." });
    }
    if (input.unitId) {
      const unit = (await db.select({ id: units.id, resortId: units.resortId }).from(units).where(eq(units.id, input.unitId)).limit(1))[0];
      if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: "Unidade do direito não encontrada." });
      if (input.resortId && unit.resortId !== input.resortId) throw new TRPCError({ code: "BAD_REQUEST", message: "A unidade do direito não pertence ao empreendimento informado." });
    }
    const [created] = await db.insert(ownershipEntitlements).values({ contractId: input.contractId, resortId: input.resortId ?? null, unitId: input.unitId ?? null, entitlementType: input.entitlementType, fixedWeek: input.fixedWeek ?? null, annualPoints: input.annualPoints, priorityLevel: input.priorityLevel, validFrom, validUntil }).$returningId();
    if (!created?.id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o direito de uso." });
    await recordAudit(ctx.user.id, "ownership_entitlement", created.id, "created", `Direito ${input.entitlementType} criado.`);
    await recordDomainEvent({ eventName: "ownership.entitlement.created", aggregateType: "ownership_entitlement", aggregateId: created.id, actorUserId: ctx.user.id, payload: { contractId: input.contractId, unitId: input.unitId ?? null, priorityLevel: input.priorityLevel, entitlementType: input.entitlementType } });
    return created;
  }),
  createMaintenanceBlock: serviceProcedure.input(z.object({ unitId: z.number().int().positive(), startsAt: z.string().trim().min(1).refine(value => !Number.isNaN(new Date(value).getTime()), "Data inicial inválida."), endsAt: z.string().trim().min(1).refine(value => !Number.isNaN(new Date(value).getTime()), "Data final inválida."), reason: z.string().trim().min(3).max(255) })).mutation(async ({ ctx, input }) => {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Fim da manutenção precisa ser posterior ao início." });
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const [created] = await db.transaction(async tx => {
      const unit = (await tx.select({ id: units.id }).from(units).where(eq(units.id, input.unitId)).limit(1).for("update"))[0];
      if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: "Unidade não encontrada." });
      const conflicts = await tx.select({ id: unitMaintenanceBlocks.id }).from(unitMaintenanceBlocks).where(and(eq(unitMaintenanceBlocks.unitId, input.unitId), lte(unitMaintenanceBlocks.startsAt, endsAt), gte(unitMaintenanceBlocks.endsAt, startsAt), inArray(unitMaintenanceBlocks.status, ["planned", "active"]))).limit(1);
      if (conflicts.length) throw new TRPCError({ code: "CONFLICT", message: "Já existe bloqueio operacional neste período." });
      return tx.insert(unitMaintenanceBlocks).values({ unitId: input.unitId, startsAt, endsAt, reason: input.reason.trim(), createdByUserId: ctx.user.id }).$returningId();
    });
    await recordAudit(ctx.user.id, "unit_maintenance_block", created.id, "created", `Bloqueio de manutenção: ${input.reason}.`);
    await recordDomainEvent({ eventName: "unit.maintenance.blocked", aggregateType: "unit_maintenance_block", aggregateId: created.id, actorUserId: ctx.user.id, payload: input }); return created;
  }),
});
