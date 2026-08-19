import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { contracts, customers, installments, reservations, resorts, tasks, unitMaintenanceBlocks, units, users } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, internalProcedure, serviceProcedure } from "./access";
import { isValidReservationPeriod, shouldCreatePaymentReminder } from "../domain";

const dateValue = (value: string) => new Date(`${value}T12:00:00Z`);
const dateTimeValue = (value: string | null | undefined) => value ? new Date(value) : null;

export const operationsRouter = router({
  resorts: internalProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(resorts).orderBy(resorts.name);
  }),

  units: internalProcedure.input(z.object({ resortId: z.number().int().positive().optional() }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ unit: units, resortName: resorts.name }).from(units).innerJoin(resorts, eq(units.resortId, resorts.id))
      .where(input?.resortId ? eq(units.resortId, input.resortId) : undefined).orderBy(resorts.name, units.code);
  }),

  createResort: adminProcedure.input(z.object({ name: z.string().trim().min(3).max(180), city: z.string().trim().max(120).optional(), state: z.string().trim().toUpperCase().max(2).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
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
      const created = await db.insert(units).values({ ...input, category: input.category || null }).$returningId();
      const id = created[0]?.id;
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível cadastrar a unidade." });
      await recordAudit(ctx.user.id, "unit", id, "created", `Unidade ${input.code} criada.`);
      return { id };
    }),

  reservations: serviceProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ reservation: reservations, customerName: customers.fullName, contractNumber: contracts.number, unitCode: units.code, resortName: resorts.name })
      .from(reservations)
      .innerJoin(customers, eq(reservations.customerId, customers.id))
      .leftJoin(contracts, eq(reservations.contractId, contracts.id))
      .innerJoin(units, eq(reservations.unitId, units.id))
      .innerJoin(resorts, eq(units.resortId, resorts.id))
      .orderBy(desc(reservations.checkIn)).limit(200);
  }),

  availableUnits: serviceProcedure.input(z.object({ checkIn: z.string().date(), checkOut: z.string().date(), resortId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const checkIn = dateValue(input.checkIn); const checkOut = dateValue(input.checkOut);
      if (!isValidReservationPeriod(checkIn, checkOut)) throw new TRPCError({ code: "BAD_REQUEST", message: "A saída precisa ser posterior ao check-in." });
      const available = await db.select({ unit: units, resortName: resorts.name }).from(units).innerJoin(resorts, eq(units.resortId, resorts.id))
        .where(and(eq(units.status, "active"), input.resortId ? eq(units.resortId, input.resortId) : undefined));
      const busy = await db.select({ unitId: reservations.unitId }).from(reservations).where(and(
        lt(reservations.checkIn, checkOut), gt(reservations.checkOut, checkIn), ne(reservations.status, "cancelled"),
      ));
      const maintenance = await db.select({ unitId: unitMaintenanceBlocks.unitId }).from(unitMaintenanceBlocks).where(and(
        lt(unitMaintenanceBlocks.startsAt, checkOut), gt(unitMaintenanceBlocks.endsAt, checkIn), inArray(unitMaintenanceBlocks.status, ["planned", "active"]),
      ));
      const busyIds = new Set([...busy.map(item => item.unitId), ...maintenance.map(item => item.unitId)]);
      return available.filter(item => !busyIds.has(item.unit.id));
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
    const conflict = await db.select({ id: reservations.id }).from(reservations).where(and(
      eq(reservations.unitId, input.unitId), lt(reservations.checkIn, checkOut), gt(reservations.checkOut, checkIn), ne(reservations.status, "cancelled"),
    )).limit(1);
    if (conflict.length) throw new TRPCError({ code: "CONFLICT", message: "Esta unidade já possui uma reserva nesse período." });
    if (input.contractId) {
      const contract = (await db.select().from(contracts).where(and(eq(contracts.id, input.contractId), eq(contracts.customerId, input.customerId))).limit(1))[0];
      if (!contract) throw new TRPCError({ code: "BAD_REQUEST", message: "O contrato informado não pertence ao cliente." });
    }
    const created = await db.insert(reservations).values({ ...input, checkIn, checkOut, contractId: input.contractId ?? null, notes: input.notes || null, createdByUserId: ctx.user.id }).$returningId();
    const id = created[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a reserva." });
    await recordAudit(ctx.user.id, "reservation", id, "created", `Reserva de ${input.checkIn} a ${input.checkOut} criada.`);
    return { id };
  }),

  updateReservationStatus: serviceProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["pending", "confirmed", "checked_in", "completed", "cancelled"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      await db.update(reservations).set({ status: input.status, checkedInAt: input.status === "checked_in" ? new Date() : undefined, checkedOutAt: input.status === "completed" ? new Date() : undefined }).where(eq(reservations.id, input.id));
      await recordAudit(ctx.user.id, "reservation", input.id, "status_updated", `Reserva atualizada para ${input.status}.`);
      return { success: true };
    }),

  tasks: internalProcedure.input(z.object({ includeDone: z.boolean().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const now = new Date();
    const [dueInstallments, openPaymentTasks] = await Promise.all([
      db.select({ installment: installments, customerId: contracts.customerId }).from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).where(inArray(installments.status, ["open", "overdue"])),
      db.select().from(tasks).where(and(eq(tasks.type, "payment"), inArray(tasks.status, ["open", "in_progress"]))),
    ]);
    const existingPaymentTaskKeys = new Set(openPaymentTasks.map(task => `${task.contractId}:${task.title}`));
    const reminders = dueInstallments.filter(({ installment }) => shouldCreatePaymentReminder(new Date(installment.dueDate), now));
    for (const { installment, customerId } of reminders) {
      const title = `Cobrar parcela #${installment.sequence}`;
      const key = `${installment.contractId}:${title}`;
      if (existingPaymentTaskKeys.has(key)) continue;
      await db.insert(tasks).values({
        title,
        description: `Lembrete automático: parcela com vencimento em ${new Date(installment.dueDate).toLocaleDateString("pt-BR")}.`,
        type: "payment",
        priority: new Date(installment.dueDate) < now ? "urgent" : "high",
        customerId,
        contractId: installment.contractId,
        assignedToUserId: ctx.user.id,
        dueAt: installment.dueDate,
        reminderAt: installment.dueDate,
        createdByUserId: ctx.user.id,
      });
      existingPaymentTaskKeys.add(key);
    }
    return db.select({ task: tasks, customerName: customers.fullName, contractNumber: contracts.number, assigneeName: users.name })
      .from(tasks).leftJoin(customers, eq(tasks.customerId, customers.id)).leftJoin(contracts, eq(tasks.contractId, contracts.id)).leftJoin(users, eq(tasks.assignedToUserId, users.id))
      .where(input?.includeDone ? undefined : inArray(tasks.status, ["open", "in_progress"]))
      .orderBy(tasks.dueAt).limit(200);
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
    const created = await db.insert(tasks).values({ ...input, description: input.description || null, customerId: input.customerId ?? null, contractId: input.contractId ?? null, assignedToUserId: input.assignedToUserId ?? ctx.user.id, dueAt: dateTimeValue(input.dueAt), reminderAt: dateTimeValue(input.reminderAt), createdByUserId: ctx.user.id }).$returningId();
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
