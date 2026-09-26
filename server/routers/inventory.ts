import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, like, lte, or, SQL } from "drizzle-orm";
import { z } from "zod";
import {
  commercialFractionHistory,
  commercialFractionHolds,
  commercialFractions,
  proposals,
  resorts,
  units,
} from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, internalProcedure, salesProcedure } from "./access";

const fractionStatus = z.enum(["available", "held", "sold", "blocked"]);
const holdStatus = z.enum(["active", "released", "expired", "consumed"]);

function fractionCode(unitCode: string, sequence: number) {
  return `${unitCode}-C${String(sequence).padStart(2, "0")}`;
}

function isExpired(value: Date | string | null | undefined, now: Date) {
  if (!value) return false;
  return new Date(value).getTime() <= now.getTime();
}

export const inventoryRouter = router({
  summary: internalProcedure.input(z.object({ resortId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return { total: 0, available: 0, held: 0, sold: 0, blocked: 0, expiredHolds: 0 };
    const rows = await db.select({ status: commercialFractions.status, heldUntil: commercialFractions.heldUntil })
      .from(commercialFractions)
      .where(eq(commercialFractions.resortId, input.resortId))
      .limit(10000);
    const now = new Date();
    const counts = { total: rows.length, available: 0, held: 0, sold: 0, blocked: 0, expiredHolds: 0 };
    for (const row of rows) {
      counts[row.status] += 1;
      if (row.status === "held" && isExpired(row.heldUntil, now)) counts.expiredHolds += 1;
    }
    return counts;
  }),

  list: internalProcedure.input(z.object({
    resortId: z.number().int().positive(),
    status: fractionStatus.optional(),
    unitId: z.number().int().positive().optional(),
    search: z.string().trim().max(120).optional(),
    limit: z.number().int().min(1).max(1000).default(500),
  })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] as string[] };
    const filters: SQL[] = [eq(commercialFractions.resortId, input.resortId)];
    if (input.status) filters.push(eq(commercialFractions.status, input.status));
    if (input.unitId) filters.push(eq(commercialFractions.unitId, input.unitId));
    if (input.search) {
      const term = `%${input.search}%`;
      filters.push(or(like(commercialFractions.code, term), like(units.code, term))!);
    }
    const rows = await db.select({
      fraction: commercialFractions,
      unitCode: units.code,
      resortName: resorts.name,
    }).from(commercialFractions)
      .innerJoin(units, eq(commercialFractions.unitId, units.id))
      .innerJoin(resorts, eq(commercialFractions.resortId, resorts.id))
      .where(and(...filters))
      .orderBy(asc(units.code), asc(commercialFractions.sequence))
      .limit(input.limit + 1);
    const truncated = rows.length > input.limit;
    return { rows: rows.slice(0, input.limit), truncated, truncatedSources: truncated ? ["estoque comercial"] : [] };
  }),

  history: internalProcedure.input(z.object({ fractionId: z.number().int().positive(), limit: z.number().int().min(1).max(200).default(100) })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(commercialFractionHistory)
      .where(eq(commercialFractionHistory.fractionId, input.fractionId))
      .orderBy(desc(commercialFractionHistory.createdAt))
      .limit(input.limit);
  }),

  bootstrap: adminProcedure.input(z.object({
    resortId: z.number().int().positive(),
    fractionsPerUnit: z.number().int().min(1).max(104).default(52),
    listPrice: z.coerce.number().positive().max(999999999).optional(),
    priceTableVersion: z.string().trim().max(80).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const resort = (await db.select({ id: resorts.id, name: resorts.name }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1))[0];
    if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento não encontrado." });
    const unitRows = await db.select({ id: units.id, code: units.code }).from(units)
      .where(eq(units.resortId, input.resortId)).orderBy(units.code).limit(1000);
    if (!unitRows.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Cadastre as UHs antes de gerar as cotas." });
    const existing = await db.select({ code: commercialFractions.code }).from(commercialFractions)
      .where(eq(commercialFractions.resortId, input.resortId)).limit(20000);
    const existingCodes = new Set(existing.map(row => row.code));
    const pending = unitRows.flatMap(unit => Array.from({ length: input.fractionsPerUnit }, (_, index) => {
      const sequence = index + 1;
      const code = fractionCode(unit.code, sequence);
      if (existingCodes.has(code)) return null;
      return {
        resortId: input.resortId,
        unitId: unit.id,
        code,
        sequence,
        status: "available" as const,
        listPrice: input.listPrice?.toFixed(2) ?? null,
        priceTableVersion: input.priceTableVersion?.trim() || null,
      };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item)));

    for (let offset = 0; offset < pending.length; offset += 400) {
      await db.insert(commercialFractions).values(pending.slice(offset, offset + 400));
    }
    await recordAudit(ctx.user.id, "commercial_inventory", input.resortId, "bootstrapped", `Estoque comercial gerado: ${pending.length} novas cotas em ${unitRows.length} UHs; ${input.fractionsPerUnit} por UH.`);
    await recordDomainEvent({ eventName: "commercial.inventory.bootstrapped", aggregateType: "resort", aggregateId: input.resortId, actorUserId: ctx.user.id, payload: { resortId: input.resortId, units: unitRows.length, fractionsPerUnit: input.fractionsPerUnit, createdFractions: pending.length } });
    return { created: pending.length, units: unitRows.length, expectedTotal: unitRows.length * input.fractionsPerUnit };
  }),

  createHold: salesProcedure.input(z.object({
    fractionId: z.number().int().positive(),
    proposalId: z.number().int().positive().optional().nullable(),
    ttlMinutes: z.number().int().min(5).max(240).default(30),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000);
    const result = await db.transaction(async tx => {
      if (input.proposalId) {
        const proposal = (await tx.select({ id: proposals.id, status: proposals.status }).from(proposals).where(eq(proposals.id, input.proposalId)).limit(1))[0];
        if (!proposal) throw new TRPCError({ code: "NOT_FOUND", message: "Proposta não encontrada." });
        if (["rejected", "expired"].includes(proposal.status)) throw new TRPCError({ code: "CONFLICT", message: "A proposta não pode reservar estoque neste status." });
      }
      const fraction = (await tx.select().from(commercialFractions).where(eq(commercialFractions.id, input.fractionId)).limit(1).for("update"))[0];
      if (!fraction) throw new TRPCError({ code: "NOT_FOUND", message: "Cota não encontrada." });
      if (fraction.status === "sold") throw new TRPCError({ code: "CONFLICT", message: "A cota já foi vendida." });
      if (fraction.status === "blocked") throw new TRPCError({ code: "CONFLICT", message: "A cota está bloqueada." });

      let previousStatus = fraction.status;
      if (fraction.status === "held") {
        const active = (await tx.select().from(commercialFractionHolds)
          .where(and(eq(commercialFractionHolds.fractionId, fraction.id), eq(commercialFractionHolds.status, "active")))
          .orderBy(desc(commercialFractionHolds.createdAt)).limit(1).for("update"))[0];
        if (active && !isExpired(active.expiresAt, now)) {
          if (active.proposalId === (input.proposalId ?? null) && active.heldByUserId === ctx.user.id) {
            return { holdId: active.id, expiresAt: active.expiresAt, reused: true };
          }
          throw new TRPCError({ code: "CONFLICT", message: "A cota já está reservada por outra negociação." });
        }
        if (active) {
          await tx.update(commercialFractionHolds).set({ status: "expired", activeKey: null, releasedAt: now, releaseReason: "TTL expirado" })
            .where(and(eq(commercialFractionHolds.id, active.id), eq(commercialFractionHolds.status, "active")));
        }
        await tx.update(commercialFractions).set({ status: "available", currentProposalId: null, heldUntil: null })
          .where(eq(commercialFractions.id, fraction.id));
        await tx.insert(commercialFractionHistory).values({ fractionId: fraction.id, fromStatus: "held", toStatus: "available", proposalId: active?.proposalId ?? null, actorUserId: ctx.user.id, reason: "Hold expirado antes de nova reserva" });
        previousStatus = "available";
      }

      const created = await tx.insert(commercialFractionHolds).values({
        fractionId: fraction.id,
        proposalId: input.proposalId ?? null,
        heldByUserId: ctx.user.id,
        activeKey: `fraction:${fraction.id}`,
        status: "active",
        expiresAt,
      }).$returningId();
      const holdId = created[0]?.id;
      if (!holdId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível reservar a cota." });
      await tx.update(commercialFractions).set({ status: "held", currentProposalId: input.proposalId ?? null, heldUntil: expiresAt, blockedReason: null })
        .where(eq(commercialFractions.id, fraction.id));
      await tx.insert(commercialFractionHistory).values({ fractionId: fraction.id, fromStatus: previousStatus, toStatus: "held", proposalId: input.proposalId ?? null, actorUserId: ctx.user.id, reason: "Hold comercial criado" });
      return { holdId, expiresAt, reused: false };
    });
    await recordAudit(ctx.user.id, "commercial_fraction", input.fractionId, result.reused ? "hold_reused" : "held", `Cota reservada até ${new Date(result.expiresAt).toISOString()}.`);
    if (!result.reused) await recordDomainEvent({ eventName: "commercial.fraction.status.changed", aggregateType: "commercial_fraction", aggregateId: input.fractionId, actorUserId: ctx.user.id, payload: { fractionId: input.fractionId, status: "held", proposalId: input.proposalId ?? null, holdId: result.holdId, expiresAt: new Date(result.expiresAt).toISOString() } });
    return result;
  }),

  releaseHold: salesProcedure.input(z.object({
    holdId: z.number().int().positive(),
    reason: z.string().trim().min(3).max(255).default("Liberação manual"),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const now = new Date();
    const result = await db.transaction(async tx => {
      const hold = (await tx.select().from(commercialFractionHolds).where(eq(commercialFractionHolds.id, input.holdId)).limit(1).for("update"))[0];
      if (!hold) throw new TRPCError({ code: "NOT_FOUND", message: "Hold não encontrado." });
      if (hold.status !== "active") return { fractionId: hold.fractionId, alreadyClosed: true };
      const fraction = (await tx.select().from(commercialFractions).where(eq(commercialFractions.id, hold.fractionId)).limit(1).for("update"))[0];
      if (!fraction) throw new TRPCError({ code: "NOT_FOUND", message: "Cota do hold não encontrada." });
      await tx.update(commercialFractionHolds).set({ status: "released", activeKey: null, releasedAt: now, releaseReason: input.reason }).where(and(eq(commercialFractionHolds.id, hold.id), eq(commercialFractionHolds.status, "active")));
      if (fraction.status === "held") {
        await tx.update(commercialFractions).set({ status: "available", currentProposalId: null, heldUntil: null }).where(eq(commercialFractions.id, fraction.id));
        await tx.insert(commercialFractionHistory).values({ fractionId: fraction.id, fromStatus: "held", toStatus: "available", proposalId: hold.proposalId, actorUserId: ctx.user.id, reason: input.reason });
      }
      return { fractionId: fraction.id, alreadyClosed: false };
    });
    if (!result.alreadyClosed) {
      await recordAudit(ctx.user.id, "commercial_fraction", result.fractionId, "hold_released", input.reason);
      await recordDomainEvent({ eventName: "commercial.fraction.status.changed", aggregateType: "commercial_fraction", aggregateId: result.fractionId, actorUserId: ctx.user.id, payload: { fractionId: result.fractionId, status: "available", holdId: input.holdId, reason: input.reason } });
    }
    return { success: true, ...result };
  }),

  sweepExpiredHolds: adminProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const now = new Date();
    const outcome = await db.transaction(async tx => {
      const expired = await tx.select().from(commercialFractionHolds)
        .where(and(eq(commercialFractionHolds.status, "active"), lte(commercialFractionHolds.expiresAt, now)))
        .for("update");
      if (!expired.length) return { holds: 0, fractions: [] as number[] };
      const holdIds = expired.map(item => item.id);
      const fractionIds = Array.from(new Set(expired.map(item => item.fractionId)));
      await tx.update(commercialFractionHolds).set({ status: "expired", activeKey: null, releasedAt: now, releaseReason: "TTL expirado" }).where(inArray(commercialFractionHolds.id, holdIds));
      const lockedFractions = await tx.select().from(commercialFractions).where(inArray(commercialFractions.id, fractionIds)).for("update");
      const released = lockedFractions.filter(item => item.status === "held").map(item => item.id);
      if (released.length) {
        await tx.update(commercialFractions).set({ status: "available", currentProposalId: null, heldUntil: null }).where(and(inArray(commercialFractions.id, released), eq(commercialFractions.status, "held")));
        await tx.insert(commercialFractionHistory).values(released.map(fractionId => ({ fractionId, fromStatus: "held", toStatus: "available", actorUserId: ctx.user.id, reason: "Sweep de hold expirado" })));
      }
      return { holds: expired.length, fractions: released };
    });
    await recordAudit(ctx.user.id, "commercial_inventory", "expired_holds", "swept", `${outcome.holds} holds expirados; ${outcome.fractions.length} cotas liberadas.`);
    return outcome;
  }),

  block: adminProcedure.input(z.object({ fractionId: z.number().int().positive(), reason: z.string().trim().min(3).max(255) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const previous = await db.transaction(async tx => {
      const fraction = (await tx.select().from(commercialFractions).where(eq(commercialFractions.id, input.fractionId)).limit(1).for("update"))[0];
      if (!fraction) throw new TRPCError({ code: "NOT_FOUND", message: "Cota não encontrada." });
      if (fraction.status === "sold") throw new TRPCError({ code: "CONFLICT", message: "Cota vendida não pode ser bloqueada por este fluxo." });
      if (fraction.status === "held") throw new TRPCError({ code: "CONFLICT", message: "Libere o hold antes de bloquear a cota." });
      if (fraction.status === "blocked") return "blocked" as const;
      await tx.update(commercialFractions).set({ status: "blocked", blockedReason: input.reason }).where(eq(commercialFractions.id, input.fractionId));
      await tx.insert(commercialFractionHistory).values({ fractionId: input.fractionId, fromStatus: fraction.status, toStatus: "blocked", actorUserId: ctx.user.id, reason: input.reason });
      return fraction.status;
    });
    if (previous !== "blocked") {
      await recordAudit(ctx.user.id, "commercial_fraction", input.fractionId, "blocked", input.reason);
      await recordDomainEvent({ eventName: "commercial.fraction.status.changed", aggregateType: "commercial_fraction", aggregateId: input.fractionId, actorUserId: ctx.user.id, payload: { fractionId: input.fractionId, status: "blocked", reason: input.reason } });
    }
    return { success: true };
  }),

  unblock: adminProcedure.input(z.object({ fractionId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const changed = await db.transaction(async tx => {
      const fraction = (await tx.select().from(commercialFractions).where(eq(commercialFractions.id, input.fractionId)).limit(1).for("update"))[0];
      if (!fraction) throw new TRPCError({ code: "NOT_FOUND", message: "Cota não encontrada." });
      if (fraction.status !== "blocked") return false;
      await tx.update(commercialFractions).set({ status: "available", blockedReason: null }).where(eq(commercialFractions.id, input.fractionId));
      await tx.insert(commercialFractionHistory).values({ fractionId: input.fractionId, fromStatus: "blocked", toStatus: "available", actorUserId: ctx.user.id, reason: "Desbloqueio administrativo" });
      return true;
    });
    if (changed) {
      await recordAudit(ctx.user.id, "commercial_fraction", input.fractionId, "unblocked", "Cota devolvida ao estoque disponível.");
      await recordDomainEvent({ eventName: "commercial.fraction.status.changed", aggregateType: "commercial_fraction", aggregateId: input.fractionId, actorUserId: ctx.user.id, payload: { fractionId: input.fractionId, status: "available", reason: "Desbloqueio administrativo" } });
    }
    return { success: true };
  }),
});
