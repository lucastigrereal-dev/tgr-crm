import { and, desc, eq, gte, inArray, lt, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { captureRecords, commercialProjectSettings, customers, opportunities, resorts, salesCampaigns, tasks, users } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { receptionProcedure, salesProcedure } from "./access";
import { getCaptureAppointmentPlan, getCaptureReadiness } from "../captureDomain";
import { getProjectCaptureReadiness } from "../projectPolicy";
import { activeRoomStatuses, assertReceptionAction, filterReceptionQueue, tourDurationMinutes } from "../salesRoomDomain";

const optionalText = z.string().trim().max(5000).optional().nullable();
const optionalShort = z.string().trim().max(255).optional().nullable();

const captureInput = z.object({
  customerId: z.number().int().positive().optional(),
  customer: z.object({
    fullName: z.string().trim().min(3).max(255),
    documentNumber: z.string().trim().max(32).optional().nullable(),
    email: z.string().trim().email().max(320).optional().or(z.literal("")),
    phone: z.string().trim().max(32).optional().nullable(),
    birthDate: z.string().date().optional().nullable(),
    occupation: z.string().trim().max(120).optional().nullable(),
    city: z.string().trim().max(120).optional().nullable(),
    state: z.string().trim().toUpperCase().max(2).optional().nullable(),
  }).optional(),
  campaignId: z.number().int().positive().optional().nullable(),
  resortId: z.number().int().positive().optional().nullable(),
  promoterId: z.number().int().positive().optional().nullable(),
  qualifierId: z.number().int().positive().optional().nullable(),
  linerId: z.number().int().positive().optional().nullable(),
  closerId: z.number().int().positive().optional().nullable(),
  roomManagerId: z.number().int().positive().optional().nullable(),
  salesRoom: optionalShort,
  captureLocation: optionalShort,
  lodgingLocation: optionalShort,
  transportation: z.string().trim().max(100).optional().nullable(),
  isPasserby: z.boolean().default(false),
  scheduledAt: z.string().datetime().optional().nullable(),
  qualificationStatus: z.enum(["pending", "qualified", "disqualified"]).default("pending"),
  qualificationReason: optionalText,
  partnerName: optionalShort,
  partnerAge: z.number().int().min(0).max(120).optional().nullable(),
  partnerProfession: z.string().trim().max(120).optional().nullable(),
  partnerProfessionNotes: optionalText,
  relationshipStatus: z.string().trim().max(64).optional().nullable(),
  relationshipYears: z.number().int().min(0).max(100).optional().nullable(),
  relationshipMonths: z.number().int().min(0).max(11).optional().nullable(),
  childrenCount: z.number().int().min(0).max(20).default(0),
  childrenNames: optionalText,
  primaryProfessionNotes: optionalText,
  averageIncome: z.number().min(0).max(99999999).optional().nullable(),
  vehicleBrand: z.string().trim().max(100).optional().nullable(),
  vehicleModel: z.string().trim().max(120).optional().nullable(),
  vehicleYear: z.number().int().min(1900).max(2100).optional().nullable(),
  hasCreditCard: z.boolean().optional().nullable(),
  creditCardBrands: optionalText,
  acceptsCheque: z.boolean().optional().nullable(),
  ownsHome: z.boolean().optional().nullable(),
  ownsPropertyInCity: z.boolean().optional().nullable(),
  travelWeeksPerYear: z.number().min(0).max(52).optional().nullable(),
  usualTravelSeason: optionalShort,
  dreamTrips: optionalText,
  lastTrip: optionalText,
  averageHotelSpend: z.number().min(0).max(99999999).optional().nullable(),
  nextFamilyTrip: optionalText,
  socialNetworks: optionalText,
  giftDescription: optionalShort,
  notes: optionalText,
  createOpportunity: z.boolean().default(true),
}).refine(input => Boolean(input.customerId || input.customer), { message: "Informe um associado existente ou os dados do novo titular." });

function nullIfBlank(value?: string | null) { return value?.trim() ? value.trim() : null; }
const clean = <T>(value: T | undefined | null) => value ?? null;
const presentationStatuses = ["captured", "scheduled", "checked_in", "presented", "no_tour", "closed"] as const;

async function findCaptureOrThrow(id: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const capture = (await db.select().from(captureRecords).where(eq(captureRecords.id, id)).limit(1))[0];
  if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
  return { db, capture };
}

function assertAction(state: Parameters<typeof assertReceptionAction>[0], action: Parameters<typeof assertReceptionAction>[1]) {
  try {
    assertReceptionAction(state, action);
  } catch (error) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Transição de recepção inválida." });
  }
}

export const capturesRouter = router({
  selectors: receptionProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { campaigns: [], sellers: [], resorts: [] };
    const [campaigns, sellers, resortRows] = await Promise.all([
      db.select({ id: salesCampaigns.id, name: salesCampaigns.name, code: salesCampaigns.code, status: salesCampaigns.status }).from(salesCampaigns).orderBy(desc(salesCampaigns.createdAt)),
      db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(or(eq(users.role, "admin"), eq(users.role, "seller"))).orderBy(users.name),
      db.select({ id: resorts.id, name: resorts.name }).from(resorts),
    ]);
    return { campaigns, sellers, resorts: resortRows };
  }),

  list: salesProcedure.input(z.object({ status: z.enum(presentationStatuses).optional() }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select({ capture: captureRecords, customer: customers, campaign: salesCampaigns }).from(captureRecords)
      .innerJoin(customers, eq(captureRecords.customerId, customers.id))
      .leftJoin(salesCampaigns, eq(captureRecords.campaignId, salesCampaigns.id))
      .where(input?.status ? eq(captureRecords.presentationStatus, input.status) : undefined)
      .orderBy(desc(captureRecords.createdAt)).limit(120);
    return rows.map(row => ({ ...row, readiness: getCaptureReadiness({ customerName: row.customer.fullName, phone: row.customer.phone, city: row.customer.city, promoterId: row.capture.promoterId, captureLocation: row.capture.captureLocation, averageIncome: row.capture.averageIncome ? Number(row.capture.averageIncome) : null, travelWeeksPerYear: row.capture.travelWeeksPerYear ? Number(row.capture.travelWeeksPerYear) : null, qualificationStatus: row.capture.qualificationStatus }) }));
  }),

  create: salesProcedure.input(captureInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const result = await db.transaction(async tx => {
      if (input.resortId) {
        const settings = (await tx.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, input.resortId)).limit(1))[0];
        const readiness = getProjectCaptureReadiness({ customerName: input.customer?.fullName, phone: input.customer?.phone, city: input.customer?.city, promoterId: input.promoterId, captureLocation: input.captureLocation, averageIncome: input.averageIncome, travelWeeksPerYear: input.travelWeeksPerYear, qualificationStatus: input.qualificationStatus, vehicle: input.vehicleBrand || input.vehicleModel, homeOwnership: input.ownsHome === true ? "sim" : null }, settings?.requiredCaptureFields);
        if (readiness.missing.some(field => field === "Veículo" || field === "Moradia")) throw new TRPCError({ code: "BAD_REQUEST", message: `Ficha incompleta para este empreendimento: ${readiness.missing.join(", ")}.` });
      }
      let customerId = input.customerId;
      let customerName = "Associado";
      if (!customerId && input.customer) {
        const matches = [];
        if (nullIfBlank(input.customer.documentNumber)) matches.push(eq(customers.documentNumber, nullIfBlank(input.customer.documentNumber)!));
        if (nullIfBlank(input.customer.email)) matches.push(eq(customers.email, nullIfBlank(input.customer.email)!));
        if (nullIfBlank(input.customer.phone)) matches.push(eq(customers.phone, nullIfBlank(input.customer.phone)!));
        const existing = matches.length ? (await tx.select().from(customers).where(or(...matches)).limit(1))[0] : undefined;
        if (existing) { customerId = existing.id; customerName = existing.fullName; }
        else {
          const insertedCustomer = await tx.insert(customers).values({ fullName: input.customer.fullName, documentNumber: nullIfBlank(input.customer.documentNumber), email: nullIfBlank(input.customer.email), phone: nullIfBlank(input.customer.phone), birthDate: input.customer.birthDate ? new Date(`${input.customer.birthDate}T12:00:00Z`) : null, occupation: nullIfBlank(input.customer.occupation), city: nullIfBlank(input.customer.city), state: nullIfBlank(input.customer.state), acquisitionSource: "captação", status: "prospect" }).$returningId();
          customerId = insertedCustomer[0]?.id;
          customerName = input.customer.fullName;
          if (!customerId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o associado da captação." });
        }
      }
      if (!customerId) throw new TRPCError({ code: "BAD_REQUEST", message: "Associado inválido para captação." });
      let opportunityId: number | null = null;
      if (input.createOpportunity) {
        const opportunity = await tx.insert(opportunities).values({ customerId, sellerId: clean(input.closerId) ?? clean(input.linerId), campaignId: clean(input.campaignId), title: `Captação · ${customerName}`, stage: input.qualificationStatus === "qualified" ? "qualified" : "new", source: nullIfBlank(input.captureLocation) ?? "captação", expectedAmount: "0.00", probability: input.qualificationStatus === "qualified" ? 30 : 10 }).$returningId();
        opportunityId = opportunity[0]?.id ?? null;
      }
      const appointmentPlan = getCaptureAppointmentPlan({ customerName, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, salesRoom: input.salesRoom });
      const inserted = await tx.insert(captureRecords).values({
        customerId, resortId: clean(input.resortId), opportunityId, campaignId: clean(input.campaignId), promoterId: clean(input.promoterId), qualifierId: clean(input.qualifierId), linerId: clean(input.linerId), closerId: clean(input.closerId), roomManagerId: clean(input.roomManagerId), salesRoom: nullIfBlank(input.salesRoom), captureLocation: nullIfBlank(input.captureLocation), lodgingLocation: nullIfBlank(input.lodgingLocation), transportation: nullIfBlank(input.transportation), isPasserby: input.isPasserby, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, presentationStatus: appointmentPlan.presentationStatus, qualificationStatus: input.qualificationStatus, qualificationReason: nullIfBlank(input.qualificationReason), partnerName: nullIfBlank(input.partnerName), partnerAge: clean(input.partnerAge), partnerProfession: nullIfBlank(input.partnerProfession), partnerProfessionNotes: nullIfBlank(input.partnerProfessionNotes), relationshipStatus: nullIfBlank(input.relationshipStatus), relationshipYears: clean(input.relationshipYears), relationshipMonths: clean(input.relationshipMonths), childrenCount: input.childrenCount, childrenNames: nullIfBlank(input.childrenNames), primaryProfessionNotes: nullIfBlank(input.primaryProfessionNotes), averageIncome: input.averageIncome?.toFixed(2) ?? null, vehicleBrand: nullIfBlank(input.vehicleBrand), vehicleModel: nullIfBlank(input.vehicleModel), vehicleYear: clean(input.vehicleYear), hasCreditCard: clean(input.hasCreditCard), creditCardBrands: nullIfBlank(input.creditCardBrands), acceptsCheque: clean(input.acceptsCheque), ownsHome: clean(input.ownsHome), ownsPropertyInCity: clean(input.ownsPropertyInCity), travelWeeksPerYear: input.travelWeeksPerYear?.toFixed(1) ?? null, usualTravelSeason: nullIfBlank(input.usualTravelSeason), dreamTrips: nullIfBlank(input.dreamTrips), lastTrip: nullIfBlank(input.lastTrip), averageHotelSpend: input.averageHotelSpend?.toFixed(2) ?? null, nextFamilyTrip: nullIfBlank(input.nextFamilyTrip), socialNetworks: nullIfBlank(input.socialNetworks), giftDescription: nullIfBlank(input.giftDescription), notes: nullIfBlank(input.notes) }).$returningId();
      const captureId = inserted[0]?.id;
      if (!captureId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar a ficha de captação." });
      let taskId: number | null = null;
      if (appointmentPlan.task) {
        const scheduledTask = await tx.insert(tasks).values({ title: appointmentPlan.task.title, description: appointmentPlan.task.description, type: "follow_up", priority: input.qualificationStatus === "qualified" ? "high" : "normal", customerId, assignedToUserId: clean(input.linerId) ?? clean(input.closerId) ?? ctx.user.id, dueAt: appointmentPlan.task.dueAt, reminderAt: appointmentPlan.task.reminderAt, createdByUserId: ctx.user.id }).$returningId();
        taskId = scheduledTask[0]?.id ?? null;
      }
      return { captureId, customerId, opportunityId, taskId };
    });
    await recordAudit(ctx.user.id, "capture", result.captureId, "created", `Ficha de captação criada para associado ${result.customerId}.`);
    if (result.taskId) await recordAudit(ctx.user.id, "task", result.taskId, "created", `Acompanhamento de captação criado para ficha ${result.captureId}.`);
    await recordDomainEvent({ eventName: "capture.created", aggregateType: "capture", aggregateId: result.captureId, actorUserId: ctx.user.id, payload: { customerId: result.customerId, campaignId: input.campaignId ?? null, qualificationStatus: input.qualificationStatus } });
    if (result.opportunityId) await recordDomainEvent({ eventName: "opportunity.created", aggregateType: "opportunity", aggregateId: result.opportunityId, actorUserId: ctx.user.id, payload: { customerId: result.customerId, stage: input.qualificationStatus === "qualified" ? "qualified" : "new", campaignId: input.campaignId ?? null } });
    return result;
  }),

  updateStatus: salesProcedure.input(z.object({ id: z.number().int().positive(), presentationStatus: z.enum(["captured", "scheduled", "checked_in", "presented", "no_tour", "closed"]), qualificationStatus: z.enum(["pending", "qualified", "disqualified"]).optional(), qualificationReason: optionalText, noTourReason: optionalText })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.update(captureRecords).set({ presentationStatus: input.presentationStatus, qualificationStatus: input.qualificationStatus, qualificationReason: nullIfBlank(input.qualificationReason), noTourReason: nullIfBlank(input.noTourReason), checkedInAt: input.presentationStatus === "checked_in" ? new Date() : undefined }).where(eq(captureRecords.id, input.id));
    await recordAudit(ctx.user.id, "capture", input.id, "status_updated", `Captação atualizada para ${input.presentationStatus}.`);
    await recordDomainEvent({ eventName: "capture.status.updated", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { presentationStatus: input.presentationStatus, qualificationStatus: input.qualificationStatus ?? null } });
    return { success: true };
  }),

  receptionQueue: receptionProcedure.input(z.object({ date: z.string().date().optional(), salesRoom: optionalShort, includeCompleted: z.boolean().default(false) }).optional()).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    const date = input?.date ?? new Date().toISOString().slice(0, 10);
    const start = new Date(`${date}T00:00:00-03:00`);
    const end = new Date(`${date}T23:59:59.999-03:00`);
    const filters = [gte(captureRecords.scheduledAt, start), lt(captureRecords.scheduledAt, end)];
    if (input?.salesRoom?.trim()) filters.push(eq(captureRecords.salesRoom, input.salesRoom.trim()));
    if (!input?.includeCompleted) filters.push(inArray(captureRecords.presentationStatus, activeRoomStatuses));
    const rows = await db.select({ capture: captureRecords, customer: customers, campaign: salesCampaigns }).from(captureRecords)
      .innerJoin(customers, eq(captureRecords.customerId, customers.id))
      .leftJoin(salesCampaigns, eq(captureRecords.campaignId, salesCampaigns.id))
      .where(and(...filters)).orderBy(captureRecords.scheduledAt);
    return filterReceptionQueue(rows, { date, salesRoom: input?.salesRoom, includeCompleted: input?.includeCompleted }).map(row => ({ ...row, durationMinutes: tourDurationMinutes(row.capture.presentationStartedAt, row.capture.presentationEndedAt) }));
  }),

  checkIn: receptionProcedure.input(z.object({ id: z.number().int().positive(), receptionNotes: optionalText })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id);
    assertAction(capture, "check_in");
    const checkedInAt = new Date();
    await db.update(captureRecords).set({ presentationStatus: "checked_in", checkedInAt, receptionNotes: nullIfBlank(input.receptionNotes) ?? capture.receptionNotes }).where(eq(captureRecords.id, input.id));
    await recordAudit(ctx.user.id, "capture", input.id, "checked_in", "Chegada confirmada pela recepção.");
    await recordDomainEvent({ eventName: "capture.checked_in", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom } });
    return { success: true, checkedInAt };
  }),

  assignRoom: receptionProcedure.input(z.object({ id: z.number().int().positive(), salesTable: z.string().trim().min(1).max(64), linerId: z.number().int().positive().optional().nullable(), closerId: z.number().int().positive().optional().nullable(), roomManagerId: z.number().int().positive().optional().nullable(), receptionNotes: optionalText })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id);
    assertAction(capture, "assign_table");
    const assignedAt = new Date();
    await db.update(captureRecords).set({ salesTable: input.salesTable, linerId: clean(input.linerId), closerId: clean(input.closerId), roomManagerId: clean(input.roomManagerId), assignedAt, receptionNotes: nullIfBlank(input.receptionNotes) ?? capture.receptionNotes }).where(eq(captureRecords.id, input.id));
    await recordAudit(ctx.user.id, "capture", input.id, "room_assigned", `Mesa ${input.salesTable} e equipe da sala atribuídas.`);
    await recordDomainEvent({ eventName: "capture.room.assigned", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, salesTable: input.salesTable, linerId: input.linerId ?? null, closerId: input.closerId ?? null, roomManagerId: input.roomManagerId ?? null } });
    return { success: true, assignedAt };
  }),

  startPresentation: receptionProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id);
    assertAction(capture, "start_presentation");
    const presentationStartedAt = new Date();
    await db.update(captureRecords).set({ presentationStatus: "presented", presentationStartedAt, presentationEndedAt: null }).where(eq(captureRecords.id, input.id));
    await recordAudit(ctx.user.id, "capture", input.id, "presentation_started", `Apresentação iniciada na mesa ${capture.salesTable}.`);
    await recordDomainEvent({ eventName: "capture.presentation.started", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, salesTable: capture.salesTable } });
    return { success: true, presentationStartedAt };
  }),

  endPresentation: receptionProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id);
    assertAction(capture, "end_presentation");
    const presentationEndedAt = new Date();
    const durationMinutes = tourDurationMinutes(capture.presentationStartedAt, presentationEndedAt);
    await db.update(captureRecords).set({ presentationStatus: "closed", presentationEndedAt }).where(eq(captureRecords.id, input.id));
    await recordAudit(ctx.user.id, "capture", input.id, "presentation_ended", `Apresentação concluída e encerrada após ${durationMinutes} minutos.`);
    await recordDomainEvent({ eventName: "capture.presentation.ended", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, salesTable: capture.salesTable, durationMinutes } });
    return { success: true, presentationEndedAt, durationMinutes };
  }),

  markNoTour: receptionProcedure.input(z.object({ id: z.number().int().positive(), reason: z.string().trim().min(3).max(5000), receptionNotes: optionalText })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id);
    assertAction(capture, "mark_no_tour");
    const endedAt = new Date();
    await db.update(captureRecords).set({ presentationStatus: "no_tour", noTourReason: input.reason, presentationEndedAt: endedAt, receptionNotes: nullIfBlank(input.receptionNotes) ?? capture.receptionNotes }).where(eq(captureRecords.id, input.id));
    await recordAudit(ctx.user.id, "capture", input.id, "no_tour", "Captação encerrada sem tour com motivo registrado.");
    await recordDomainEvent({ eventName: "capture.no_tour", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, reason: input.reason } });
    return { success: true, endedAt };
  }),
});
