import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, notExists, or, SQL } from "drizzle-orm";
import { z } from "zod";
import { contracts, customers, installments, ownershipEntitlements, reservationGuests, reservationWaitlist, reservations, resorts, tasks, unitMaintenanceBlocks, units, users } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, internalProcedure, serviceProcedure } from "./access";
import { entitlementPriorityScore, getCollectionStage, isValidReservationPeriod, shouldCreatePaymentReminder } from "../domain";
import { canTransitionReservationStatus, canTransitionWaitlistStatus } from "../../shared/reservationLifecycle";

const dateValue = (value: string) => new Date(`${value}T12:00:00Z`);
const dateTimeValue = (value: string | null | undefined) => value ? new Date(value) : null;

export const operationsRouter = router({
  resorts: internalProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(resorts).orderBy(resorts.name).limit(1000);
  }),

  units: internalProcedure.input(z.object({ resortId: z.number().int().positive().optional(), status: z.enum(["active", "maintenance", "inactive"]).optional(), search: z.string().trim().max(120).optional(), limit: z.number().int().min(1).max(5000).default(5000) }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    const filters: SQL[] = [];
    if (input?.resortId) filters.push(eq(units.resortId, input.resortId));
    if (input?.status) filters.push(eq(units.status, input.status));
    if (input?.search) filters.push(or(like(units.code, `%${input.search}%`), like(units.category, `%${input.search}%`), like(resorts.name, `%${input.search}%`))!);
    return db.select({ unit: units, resortName: resorts.name }).from(units).innerJoin(resorts, eq(units.resortId, resorts.id))
      .where(filters.length ? and(...filters) : undefined).orderBy(resorts.name, units.code).limit(input?.limit ?? 5000);
  }),

  createResort: adminProcedure.input(z.object({ name: z.string().trim().min(3).max(180), city: z.string().trim().max(120).optional(), state: z.string().trim().toUpperCase().max(2).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const duplicate = (await db.select({ id: resorts.id }).from(resorts).where(eq(resorts.name, input.name)).limit(1))[0];
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe um empreendimento com este nome." });
      const created = await db.insert(resorts).values({ name: input.name, city: input.city || null, state: input.state || null }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível cadastrar o empreendimento." });
      await recordAudit(ctx.user.id, "resort", id, "created", `Empreendimento ${input.name} criado.`);
      return { id };
    }),

  createUnit: adminProcedure.input(z.object({ resortId: z.number().int().positive(), code: z.string().trim().min(1).max(64), category: z.string().trim().max(100).optional(), capacity: z.coerce.number().int().min(1).max(30).default(2), beds: z.coerce.number().int().min(1).max(15).default(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const resort = (await db.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1))[0];
      if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento não encontrado." });
      const duplicate = (await db.select({ id: units.id }).from(units).where(and(eq(units.resortId, input.resortId), eq(units.code, input.code))).limit(1))[0];
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe uma unidade com este código no empreendimento." });
      const created = await db.insert(units).values({ ...input, category: input.category || null }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível cadastrar a unidade." });
      await recordAudit(ctx.user.id, "unit", id, "created", `Unidade ${input.code} criada.`);
      return { id };
    }),

  updateUnit: adminProcedure.input(z.object({ id: z.number().int().positive(), code: z.string().trim().min(1).max(64), category: z.string().trim().max(100).optional().nullable(), capacity: z.coerce.number().int().min(1).max(30), beds: z.coerce.number().int().min(1).max(15), status: z.enum(["active", "maintenance", "inactive"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const existing = (await db.select({ id: units.id, resortId: units.resortId }).from(units).where(eq(units.id, input.id)).limit(1))[0];
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Unidade não encontrada." });
      const duplicate = (await db.select({ id: units.id }).from(units).where(and(eq(units.resortId, existing.resortId), eq(units.code, input.code), ne(units.id, input.id))).limit(1))[0];
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe outra unidade com este código no empreendimento." });
      await db.update(units).set({ code: input.code, category: input.category || null, capacity: input.capacity, beds: input.beds, status: input.status }).where(eq(units.id, input.id));
      await recordAudit(ctx.user.id, "unit", input.id, "updated", `Unidade ${input.code} atualizada para ${input.status}.`);
      return { success: true };
    }),

  reservations: serviceProcedure.input(z.object({
    status: z.enum(["pending", "confirmed", "checked_in", "completed", "cancelled"]).optional(),
    search: z.string().trim().max(120).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.number().int().min(1).max(500).default(200),
  }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    const filters: SQL[] = [];
    if (input?.status) filters.push(eq(reservations.status, input.status));
    if (input?.from) filters.push(gte(reservations.checkIn, dateValue(input.from)));
    if (input?.to) filters.push(lte(reservations.checkIn, dateValue(input.to)));
    const search = input?.search?.trim();
    if (search) filters.push(or(like(customers.fullName, `%${search}%`), like(units.code, `%${search}%`), like(contracts.number, `%${search}%`))!);
    return db.select({ reservation: reservations, customerName: customers.fullName, contractNumber: contracts.number, unitCode: units.code, resortName: resorts.name })
      .from(reservations)
      .innerJoin(customers, eq(reservations.customerId, customers.id))
      .leftJoin(contracts, eq(reservations.contractId, contracts.id))
      .innerJoin(units, eq(reservations.unitId, units.id))
      .innerJoin(resorts, eq(units.resortId, resorts.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(reservations.checkIn)).limit(input?.limit ?? 200);
  }),

  waitlist: serviceProcedure.input(z.object({ search: z.string().trim().max(120).optional(), status: z.enum(["waiting", "offered"]).optional(), limit: z.number().int().min(1).max(500).default(200) }).optional()).query(async ({ input }) => {
    const db = await getDb(); if (!db) return [];
    const filters: SQL[] = [inArray(reservationWaitlist.status, ["waiting", "offered"] as const)];
    if (input?.status) filters.push(eq(reservationWaitlist.status, input.status));
    if (input?.search) filters.push(or(like(customers.fullName, `%${input.search}%`), like(resorts.name, `%${input.search}%`))!);
    return db.select({ item: reservationWaitlist, customerName: customers.fullName, resortName: resorts.name }).from(reservationWaitlist).innerJoin(customers, eq(reservationWaitlist.customerId, customers.id)).leftJoin(resorts, eq(reservationWaitlist.resortId, resorts.id)).where(and(...filters)).orderBy(desc(reservationWaitlist.priorityScore), reservationWaitlist.desiredCheckIn).limit(input?.limit ?? 200);
  }),

  joinWaitlist: serviceProcedure.input(z.object({ customerId: z.number().int().positive(), contractId: z.number().int().positive().nullable().optional(), resortId: z.number().int().positive().nullable().optional(), desiredCheckIn: z.string().date(), desiredCheckOut: z.string().date(), partySize: z.number().int().min(1).max(30).default(1), priorityScore: z.number().int().min(0).max(999).default(0), preferenceNotes: z.string().trim().max(2000).nullable().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const checkIn = dateValue(input.desiredCheckIn), checkOut = dateValue(input.desiredCheckOut);
    if (!isValidReservationPeriod(checkIn, checkOut)) throw new TRPCError({ code: "BAD_REQUEST", message: "A saída desejada precisa ser posterior à entrada." });
    const customer = (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Associado não encontrado." });
    if (input.resortId) {
      const resort = (await db.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1))[0];
      if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento não encontrado." });
    }
    let entitlementScore = 0;
    if (input.contractId) {
      const contract = (await db.select({ id: contracts.id, customerId: contracts.customerId }).from(contracts).where(and(eq(contracts.id, input.contractId), eq(contracts.customerId, input.customerId))).limit(1))[0];
      if (!contract) throw new TRPCError({ code: "BAD_REQUEST", message: "O contrato informado não pertence ao associado." });
      const entitlements = await db.select().from(ownershipEntitlements).where(and(eq(ownershipEntitlements.contractId, input.contractId), eq(ownershipEntitlements.status, "active"))).limit(1000);
      const highestPriority = entitlements.reduce<number | null>((current, entitlement) => current === null || entitlement.priorityLevel < current ? entitlement.priorityLevel : current, null);
      entitlementScore = highestPriority === null ? 0 : entitlementPriorityScore(highestPriority);
    }
    const effectivePriorityScore = Math.max(input.priorityScore, entitlementScore);
    const created = await db.insert(reservationWaitlist).values({ customerId: input.customerId, contractId: input.contractId ?? null, resortId: input.resortId ?? null, desiredCheckIn: checkIn, desiredCheckOut: checkOut, partySize: input.partySize, priorityScore: effectivePriorityScore, preferenceNotes: input.preferenceNotes || null, createdByUserId: ctx.user.id }).$returningId(); const id = created[0]?.id; if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível entrar na fila." });
    await recordAudit(ctx.user.id, "reservation_waitlist", id, "created", `Fila de espera criada com prioridade efetiva ${effectivePriorityScore}.`); return { id, priorityScore: effectivePriorityScore, entitlementScore };
  }),

  updateWaitlistStatus: serviceProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["waiting", "offered", "confirmed", "expired", "cancelled"]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const current = (await db.select({ status: reservationWaitlist.status }).from(reservationWaitlist).where(eq(reservationWaitlist.id, input.id)).limit(1))[0];
    if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Item da fila não encontrado." });
    if (!canTransitionWaitlistStatus(current.status, input.status)) throw new TRPCError({ code: "CONFLICT", message: `Transição de fila inválida: ${current.status} → ${input.status}.` });
    const now = new Date();
    const updateResult = await db.update(reservationWaitlist).set({ status: input.status, offeredAt: input.status === "offered" ? now : undefined, expiresAt: input.status === "offered" ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : undefined }).where(and(eq(reservationWaitlist.id, input.id), eq(reservationWaitlist.status, current.status)));
    if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "A posição da fila foi alterada por outra operação. Recarregue e tente novamente." });
    await recordAudit(ctx.user.id, "reservation_waitlist", input.id, "status_updated", `Fila de espera atualizada para ${input.status}.`);
    return { success: true };
  }),

  convertWaitlistToReservation: serviceProcedure.input(z.object({ waitlistId: z.number().int().positive(), unitId: z.number().int().positive(), notes: z.string().trim().max(3000).optional().nullable() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const reservationId = await db.transaction(async tx => {
      const item = (await tx.select().from(reservationWaitlist).where(eq(reservationWaitlist.id, input.waitlistId)).limit(1).for("update"))[0];
      if (!item || item.status !== "offered") throw new TRPCError({ code: "BAD_REQUEST", message: "A fila precisa estar com oferta ativa para virar reserva." });
      const unit = (await tx.select().from(units).where(and(eq(units.id, input.unitId), eq(units.status, "active"))).limit(1).for("update"))[0];
      if (!unit) throw new TRPCError({ code: "BAD_REQUEST", message: "Escolha uma unidade ativa para confirmar a reserva." });
      if (item.resortId && unit.resortId !== item.resortId) throw new TRPCError({ code: "BAD_REQUEST", message: "A unidade escolhida não pertence ao empreendimento solicitado." });
      const conflict = await tx.select({ id: reservations.id }).from(reservations).where(and(eq(reservations.unitId, input.unitId), lt(reservations.checkIn, item.desiredCheckOut), gt(reservations.checkOut, item.desiredCheckIn), ne(reservations.status, "cancelled"))).limit(1);
      if (conflict.length) throw new TRPCError({ code: "CONFLICT", message: "A unidade escolhida ficou indisponível neste período." });
      const maintenanceConflict = await tx.select({ id: unitMaintenanceBlocks.id }).from(unitMaintenanceBlocks).where(and(eq(unitMaintenanceBlocks.unitId, input.unitId), lt(unitMaintenanceBlocks.startsAt, item.desiredCheckOut), gt(unitMaintenanceBlocks.endsAt, item.desiredCheckIn), inArray(unitMaintenanceBlocks.status, ["planned", "active"]))).limit(1);
      if (maintenanceConflict.length) throw new TRPCError({ code: "CONFLICT", message: "A unidade está bloqueada para manutenção neste período." });
      if (item.contractId) {
        const contract = (await tx.select().from(contracts).where(and(eq(contracts.id, item.contractId), eq(contracts.customerId, item.customerId))).limit(1))[0];
        if (!contract) throw new TRPCError({ code: "BAD_REQUEST", message: "O contrato da fila não pertence ao associado." });
      }
      const created = await tx.insert(reservations).values({ customerId: item.customerId, contractId: item.contractId, unitId: input.unitId, checkIn: item.desiredCheckIn, checkOut: item.desiredCheckOut, adults: item.partySize, children: 0, notes: input.notes || item.preferenceNotes || null, status: "confirmed", createdByUserId: ctx.user.id }).$returningId();
      const id = created[0]?.id; if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível confirmar a reserva da fila." });
      await tx.update(reservationWaitlist).set({ status: "confirmed" }).where(and(eq(reservationWaitlist.id, item.id), eq(reservationWaitlist.status, "offered")));
      return { id, waitlistId: item.id };
    });
    await recordAudit(ctx.user.id, "reservation", reservationId.id, "created_from_waitlist", `Reserva criada da fila ${reservationId.waitlistId}.`);
    await recordAudit(ctx.user.id, "reservation_waitlist", reservationId.waitlistId, "converted_to_reservation", `Fila convertida na reserva ${reservationId.id}.`);
    return { reservationId: reservationId.id };
  }),

  availableUnits: serviceProcedure.input(z.object({ checkIn: z.string().date(), checkOut: z.string().date(), resortId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const checkIn = dateValue(input.checkIn); const checkOut = dateValue(input.checkOut);
      if (!isValidReservationPeriod(checkIn, checkOut)) throw new TRPCError({ code: "BAD_REQUEST", message: "A saída precisa ser posterior ao check-in." });
      const reservationConflict = db.select({ id: reservations.id }).from(reservations).where(and(
        eq(reservations.unitId, units.id), lt(reservations.checkIn, checkOut), gt(reservations.checkOut, checkIn), ne(reservations.status, "cancelled"),
      ));
      const maintenanceConflict = db.select({ id: unitMaintenanceBlocks.id }).from(unitMaintenanceBlocks).where(and(
        eq(unitMaintenanceBlocks.unitId, units.id), lt(unitMaintenanceBlocks.startsAt, checkOut), gt(unitMaintenanceBlocks.endsAt, checkIn), inArray(unitMaintenanceBlocks.status, ["planned", "active"]),
      ));
      return db.select({ unit: units, resortName: resorts.name }).from(units).innerJoin(resorts, eq(units.resortId, resorts.id))
        .where(and(eq(units.status, "active"), input.resortId ? eq(units.resortId, input.resortId) : undefined, notExists(reservationConflict), notExists(maintenanceConflict)))
        .orderBy(resorts.name, units.code).limit(5000);
    }),

  createReservation: serviceProcedure.input(z.object({
    customerId: z.number().int().positive(),
    contractId: z.number().int().positive().optional().nullable(),
    unitId: z.number().int().positive(),
    checkIn: z.string().date(),
    checkOut: z.string().date(),
    adults: z.coerce.number().int().min(1).max(30).default(1),
    children: z.coerce.number().int().min(0).max(30).default(0),
    notes: z.string().trim().max(3000).optional().nullable(),
    status: z.enum(["pending", "confirmed"]).default("pending"),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const checkIn = dateValue(input.checkIn); const checkOut = dateValue(input.checkOut);
    if (!isValidReservationPeriod(checkIn, checkOut)) throw new TRPCError({ code: "BAD_REQUEST", message: "A saída precisa ser posterior ao check-in." });
    const id = await db.transaction(async tx => {
      const customer = (await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
      if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente da reserva não encontrado." });
      const unit = (await tx.select({ id: units.id, status: units.status }).from(units).where(eq(units.id, input.unitId)).limit(1).for("update"))[0];
      if (!unit || unit.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "Escolha uma unidade ativa para criar a reserva." });
      const conflict = await tx.select({ id: reservations.id }).from(reservations).where(and(
        eq(reservations.unitId, input.unitId), lt(reservations.checkIn, checkOut), gt(reservations.checkOut, checkIn), ne(reservations.status, "cancelled"),
      )).limit(1);
      if (conflict.length) throw new TRPCError({ code: "CONFLICT", message: "Esta unidade já possui uma reserva nesse período." });
      const maintenanceConflict = await tx.select({ id: unitMaintenanceBlocks.id }).from(unitMaintenanceBlocks).where(and(eq(unitMaintenanceBlocks.unitId, input.unitId), lt(unitMaintenanceBlocks.startsAt, checkOut), gt(unitMaintenanceBlocks.endsAt, checkIn), inArray(unitMaintenanceBlocks.status, ["planned", "active"]))).limit(1);
      if (maintenanceConflict.length) throw new TRPCError({ code: "CONFLICT", message: "Esta unidade está bloqueada para manutenção no período informado." });
      if (input.contractId) {
        const contract = (await tx.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, input.contractId), eq(contracts.customerId, input.customerId))).limit(1))[0];
        if (!contract) throw new TRPCError({ code: "BAD_REQUEST", message: "O contrato informado não pertence ao cliente." });
      }
      const created = await tx.insert(reservations).values({ ...input, checkIn, checkOut, contractId: input.contractId ?? null, notes: input.notes || null, createdByUserId: ctx.user.id }).$returningId();
      const reservationId = created[0]?.id;
      if (!reservationId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a reserva." });
      return reservationId;
    });
    await recordAudit(ctx.user.id, "reservation", id, "created", `Reserva de ${input.checkIn} a ${input.checkOut} criada.`);
    return { id };
  }),

  updateReservationStatus: serviceProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["pending", "confirmed", "checked_in", "completed", "cancelled"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      const current = (await db.select({ status: reservations.status }).from(reservations).where(eq(reservations.id, input.id)).limit(1))[0];
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Reserva não encontrada." });
      if (!canTransitionReservationStatus(current.status, input.status)) throw new TRPCError({ code: "CONFLICT", message: `Transição de reserva inválida: ${current.status} → ${input.status}.` });
      const now = new Date();
      const updateResult = await db.update(reservations).set({ status: input.status, checkedInAt: input.status === "checked_in" ? now : undefined, checkedOutAt: input.status === "completed" ? now : undefined }).where(and(eq(reservations.id, input.id), eq(reservations.status, current.status)));
      if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "A reserva foi alterada por outra operação. Recarregue e tente novamente." });
      if (input.status === "completed") await db.update(reservationGuests).set({ checkedOutAt: now }).where(and(eq(reservationGuests.reservationId, input.id), isNotNull(reservationGuests.checkedInAt), isNull(reservationGuests.checkedOutAt)));
      await recordAudit(ctx.user.id, "reservation", input.id, "status_updated", `Reserva atualizada para ${input.status}.`);
      return { success: true };
    }),

  reservationGuests: serviceProcedure.input(z.object({ reservationId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb(); if (!db) return [];
    return db.select().from(reservationGuests).where(eq(reservationGuests.reservationId, input.reservationId)).orderBy(reservationGuests.createdAt).limit(100);
  }),

  addReservationGuest: serviceProcedure.input(z.object({ reservationId: z.number().int().positive(), fullName: z.string().trim().min(3).max(255), documentNumber: z.string().trim().max(32).nullable().optional(), relationship: z.string().trim().max(80).nullable().optional(), birthDate: z.string().date().nullable().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const reservation = (await db.select({ id: reservations.id, capacity: units.capacity }).from(reservations).innerJoin(units, eq(reservations.unitId, units.id)).where(eq(reservations.id, input.reservationId)).limit(1))[0];
    if (!reservation) throw new TRPCError({ code: "NOT_FOUND", message: "Reserva não encontrada." });
    const guests = await db.select({ id: reservationGuests.id }).from(reservationGuests).where(eq(reservationGuests.reservationId, input.reservationId)).limit(31);
    if (guests.length >= reservation.capacity) throw new TRPCError({ code: "CONFLICT", message: "A capacidade da unidade já foi atingida." });
    const created = await db.insert(reservationGuests).values({ reservationId: input.reservationId, fullName: input.fullName, documentNumber: input.documentNumber || null, relationship: input.relationship || null, birthDate: input.birthDate ? dateValue(input.birthDate) : null }).$returningId();
    const id = created[0]?.id; if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar o acompanhante." });
    await recordAudit(ctx.user.id, "reservation_guest", id, "created", `Acompanhante ${input.fullName} incluído na reserva ${input.reservationId}.`);
    return { id };
  }),

  updateGuestPresence: serviceProcedure.input(z.object({ id: z.number().int().positive(), action: z.enum(["check_in", "check_out"]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const guest = (await db.select({ checkedInAt: reservationGuests.checkedInAt, checkedOutAt: reservationGuests.checkedOutAt, reservationStatus: reservations.status }).from(reservationGuests).innerJoin(reservations, eq(reservationGuests.reservationId, reservations.id)).where(eq(reservationGuests.id, input.id)).limit(1))[0];
    if (!guest) throw new TRPCError({ code: "NOT_FOUND", message: "Acompanhante não encontrado." });
    if (guest.reservationStatus !== "checked_in") throw new TRPCError({ code: "BAD_REQUEST", message: "A presença só pode ser registrada durante a hospedagem." });
    if (input.action === "check_in" && guest.checkedInAt) return { success: true, alreadyCheckedIn: true };
    if (input.action === "check_out" && !guest.checkedInAt) throw new TRPCError({ code: "BAD_REQUEST", message: "O acompanhante precisa fazer check-in antes do check-out." });
    if (input.action === "check_out" && guest.checkedOutAt) return { success: true, alreadyCheckedOut: true };
    await db.update(reservationGuests).set(input.action === "check_in" ? { checkedInAt: new Date() } : { checkedOutAt: new Date() }).where(eq(reservationGuests.id, input.id));
    await recordAudit(ctx.user.id, "reservation_guest", input.id, input.action, `Presença de acompanhante registrada: ${input.action}.`);
    return { success: true, ...(input.action === "check_in" ? { alreadyCheckedIn: false } : { alreadyCheckedOut: false }) };
  }),

  tasks: internalProcedure.input(z.object({
    includeDone: z.boolean().optional(),
    status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    search: z.string().trim().max(120).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const now = new Date();
    const [dueInstallments, openPaymentTasks] = await Promise.all([
      db.select({ installment: installments, customerId: contracts.customerId }).from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).where(inArray(installments.status, ["open", "overdue"])).orderBy(installments.dueDate).limit(5000),
      db.select().from(tasks).where(and(eq(tasks.type, "payment"), inArray(tasks.status, ["open", "in_progress"]))).limit(5000),
    ]);
    const existingPaymentTaskKeys = new Set(openPaymentTasks.map(task => `${task.contractId}:${task.title}`));
    const reminders = dueInstallments.filter(({ installment }) => shouldCreatePaymentReminder(new Date(installment.dueDate), now));
    for (const { installment, customerId } of reminders) {
      const stage = getCollectionStage(new Date(installment.dueDate), now);
      const title = `[${stage.label}] Cobrar parcela #${installment.sequence}`;
      const key = `${installment.contractId}:${title}`;
      if (existingPaymentTaskKeys.has(key)) continue;
      await db.insert(tasks).values({
        title,
        description: `Régua de cobrança · ${stage.label}. Vencimento em ${new Date(installment.dueDate).toLocaleDateString("pt-BR")}. Ação recomendada em até ${stage.actionWithinHours}h.`,
        type: "payment",
        priority: stage.priority,
        customerId,
        contractId: installment.contractId,
        assignedToUserId: ctx.user.id,
        dueAt: installment.dueDate,
        reminderAt: installment.dueDate,
        createdByUserId: ctx.user.id,
      });
      existingPaymentTaskKeys.add(key);
    }
    const taskFilters: SQL[] = [];
    if (input?.status) taskFilters.push(eq(tasks.status, input.status));
    else if (!input?.includeDone) taskFilters.push(inArray(tasks.status, ["open", "in_progress"]));
    if (input?.priority) taskFilters.push(eq(tasks.priority, input.priority));
    const search = input?.search?.trim();
    if (search) taskFilters.push(or(like(tasks.title, `%${search}%`), like(customers.fullName, `%${search}%`), like(contracts.number, `%${search}%`))!);
    return db.select({ task: tasks, customerName: customers.fullName, contractNumber: contracts.number, assigneeName: users.name })
      .from(tasks).leftJoin(customers, eq(tasks.customerId, customers.id)).leftJoin(contracts, eq(tasks.contractId, contracts.id)).leftJoin(users, eq(tasks.assignedToUserId, users.id))
      .where(taskFilters.length ? and(...taskFilters) : undefined)
      .orderBy(tasks.dueAt).limit(input?.limit ?? 200);
  }),

  createTask: internalProcedure.input(z.object({
    title: z.string().trim().min(3).max(255), description: z.string().trim().max(4000).optional().nullable(),
    type: z.enum(["follow_up", "payment", "reservation", "service", "internal"]).default("internal"),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    customerId: z.number().int().positive().optional().nullable(), contractId: z.number().int().positive().optional().nullable(),
    assignedToUserId: z.number().int().positive().optional().nullable(), dueAt: z.string().datetime().optional().nullable(), reminderAt: z.string().datetime().optional().nullable(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const customerId = input.customerId ?? null;
    const contractId = input.contractId ?? null;
    const assignedToUserId = input.assignedToUserId ?? ctx.user.id;
    const [customerRows, contractRows, assigneeRows] = await Promise.all([
      customerId ? db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).limit(1) : Promise.resolve([]),
      contractId ? db.select({ id: contracts.id, customerId: contracts.customerId }).from(contracts).where(eq(contracts.id, contractId)).limit(1) : Promise.resolve([]),
      db.select({ id: users.id }).from(users).where(eq(users.id, assignedToUserId)).limit(1),
    ]);
    if (customerId && !customerRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente não encontrado." });
    const contract = contractRows[0];
    if (contractId && !contract) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
    if (contract && customerId && contract.customerId !== customerId) throw new TRPCError({ code: "BAD_REQUEST", message: "O contrato não pertence ao cliente informado." });
    if (!assigneeRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Responsável não encontrado." });
    const created = await db.insert(tasks).values({ ...input, description: input.description || null, customerId, contractId, assignedToUserId, dueAt: dateTimeValue(input.dueAt), reminderAt: dateTimeValue(input.reminderAt), createdByUserId: ctx.user.id }).$returningId();
    const id = created[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a tarefa." });
    await recordAudit(ctx.user.id, "task", id, "created", `Tarefa ${input.title} criada.`);
    return { id };
  }),

  updateTaskStatus: internalProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["open", "in_progress", "done", "cancelled"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      await db.update(tasks).set({ status: input.status, completedAt: input.status === "done" ? new Date() : null }).where(eq(tasks.id, input.id));
      await recordAudit(ctx.user.id, "task", input.id, "status_updated", `Tarefa atualizada para ${input.status}.`);
      return { success: true };
    }),
});
