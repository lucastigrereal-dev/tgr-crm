import { qualificationVersionToStamp } from "../qualificationPolicy";
import { eligibilityHookAfterCommit } from "../nonBuyerEligibilityService";
import { DEFAULT_NQ_SETTINGS } from "../captureSheetDomain";
import { and, desc, eq, gte, inArray, isNull, like, lt, lte, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { captureMotives, captureRecords, commercialProjectSettings, customers, opportunities, resorts, salesCampaigns, tasks, users } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { anonymizedCustomerError } from "../customerAnonymization";
import { router } from "../_core/trpc";
import { internalProcedure, receptionProcedure, salesProcedure } from "./access";
import { assertCaptureInRoomView, captorNameOf, resolveNtMotive, roomVisibilityCutoff, roomVisibleCondition } from "./captureSheet";
import { canOpenArchivedSheet } from "../captureSheetDomain";
import { getCaptureAppointmentPlan, getCaptureReadiness } from "../captureDomain";
import { buildCaptureProfileAnalytics, getProfileCompleteness, type CaptureProfile } from "../captureSegmentation";
import { getProjectCaptureReadiness } from "../projectPolicy";
import { activeRoomStatuses, assertReceptionAction, canTransitionPresentationStatus, filterReceptionQueue, tourDurationMinutes } from "../salesRoomDomain";
import { publishSalesRoomEvent } from "../realtime";
import { affectedRows } from "../mysqlErrors";
import { canonicalizeMasterData } from "../masterData";
import { isGuestpassPrefillEnabled, normalizePassRef } from "../guestpassConfig";
import { GuestpassLinkConflict, linkGuestpassToCapture, sanitizeFetchedAt } from "../guestpassPrefill";

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
  // F1.8: Nº do passe do GuestPass de onde a ficha foi preenchida (vínculo 1:1; só com CRM_GUESTPASS_PREFILL_ENABLED).
  guestpassPassRef: z.string().trim().max(32).optional().nullable(),
  /** Hora (ISO) em que a tela buscou o passe; vira prefillFetchedAt do vínculo. */
  guestpassFetchedAt: z.string().datetime().optional().nullable(),
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
const profileAnalysisInput = z.object({
  startDate: z.string().date().optional(), endDate: z.string().date().optional(), search: z.string().trim().max(180).optional(),
  city: z.string().trim().max(120).optional(), state: z.string().trim().toUpperCase().max(2).optional(), salesRoom: z.string().trim().max(180).optional(),
  captureLocation: z.string().trim().max(180).optional(), vehicleBrand: z.string().trim().max(100).optional(), vehicleModel: z.string().trim().max(120).optional(),
  relationshipStatus: z.string().trim().max(64).optional(), travelSeason: z.string().trim().max(180).optional(), qualificationStatus: z.enum(["pending", "qualified", "disqualified"]).optional(),
  presentationStatus: z.enum(presentationStatuses).optional(), campaignId: z.number().int().positive().optional(), resortId: z.number().int().positive().optional(),
  vehicleYearMin: z.number().int().min(1900).max(2100).optional(), vehicleYearMax: z.number().int().min(1900).max(2100).optional(),
  childrenMin: z.number().int().min(0).max(20).optional(), childrenMax: z.number().int().min(0).max(20).optional(),
  incomeMin: z.number().min(0).optional(), incomeMax: z.number().min(0).optional(), hotelSpendMin: z.number().min(0).optional(), hotelSpendMax: z.number().min(0).optional(),
  travelWeeksMin: z.number().min(0).max(52).optional(), travelWeeksMax: z.number().min(0).max(52).optional(),
  hasCreditCard: z.boolean().optional(), acceptsCheque: z.boolean().optional(), ownsHome: z.boolean().optional(), ownsPropertyInCity: z.boolean().optional(), isPasserby: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

async function findCaptureOrThrow(id: number, role: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const capture = (await db.select().from(captureRecords).where(eq(captureRecords.id, id)).limit(1))[0];
  if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
  // Ficha anonimizada a pedido do titular não aceita texto livre nem mudança de estado por nenhuma mutação.
  if (capture.anonymizedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ficha anonimizada a pedido do titular: não aceita novas alterações." });
  await assertCaptureInRoomView(db, role, capture);
  return { db, capture };
}

function assertAction(state: Parameters<typeof assertReceptionAction>[0], action: Parameters<typeof assertReceptionAction>[1]) {
  try {
    assertReceptionAction(state, action);
  } catch (error) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Transição de recepção inválida." });
  }
}

function assertCaptureUpdateSucceeded(result: unknown) {
  if (affectedRows(result) === 0) throw new TRPCError({ code: "CONFLICT", message: "A ficha de captação foi alterada por outra operação. Recarregue e tente novamente." });
}

export const capturesRouter = router({
  selectors: receptionProcedure.query(async () => {
    const db = await getDb();
    if (!db) {
      const empty = { rows: [], truncated: false, truncatedSources: [] as string[] };
      return { campaigns: empty, sellers: empty, resorts: empty };
    }
    const limit = 1_000;
    const [rawCampaigns, rawSellers, rawResorts] = await Promise.all([
      db.select({ id: salesCampaigns.id, name: salesCampaigns.name, code: salesCampaigns.code, status: salesCampaigns.status }).from(salesCampaigns).orderBy(desc(salesCampaigns.createdAt)).limit(limit + 1),
      db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(or(eq(users.role, "admin"), eq(users.role, "seller"))).orderBy(users.name).limit(limit + 1),
      db.select({ id: resorts.id, name: resorts.name }).from(resorts).orderBy(resorts.name).limit(limit + 1),
    ]);
    const envelope = <T,>(rows: T[], source: string) => ({ rows: rows.slice(0, limit), truncated: rows.length > limit, truncatedSources: rows.length > limit ? [source] : [] });
    return { campaigns: envelope(rawCampaigns, "campanhas de captação"), sellers: envelope(rawSellers, "vendedores de captação"), resorts: envelope(rawResorts, "empreendimentos de captação") };
  }),

  list: salesProcedure.input(z.object({ status: z.enum(presentationStatuses).optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 120;
    const rawRows = await db.select({ capture: captureRecords, customer: customers, campaign: salesCampaigns }).from(captureRecords)
      .innerJoin(customers, eq(captureRecords.customerId, customers.id))
      .leftJoin(salesCampaigns, eq(captureRecords.campaignId, salesCampaigns.id))
      // LGPD (decisão do Lucas 17/10): ficha de quem não comprou sai da vista da sala depois do dia; só admin e finance seguem vendo.
      .where(and(input?.status ? eq(captureRecords.presentationStatus, input.status) : undefined, canOpenArchivedSheet(ctx.user.role) ? undefined : roomVisibleCondition(await roomVisibilityCutoff())))
      .orderBy(desc(captureRecords.createdAt)).limit(limit + 1);
    const rows = rawRows.slice(0, limit).map(row => ({ ...row, readiness: getCaptureReadiness({ customerName: row.customer.fullName, phone: row.customer.phone, city: row.customer.city, promoterId: row.capture.promoterId, captureLocation: row.capture.captureLocation, averageIncome: row.capture.averageIncome ? Number(row.capture.averageIncome) : null, travelWeeksPerYear: row.capture.travelWeeksPerYear ? Number(row.capture.travelWeeksPerYear) : null, qualificationStatus: row.capture.qualificationStatus }) }));
    const truncated = rawRows.length > limit;
    return { rows, truncated, truncatedSources: truncated ? ["fichas de captação"] : [] };
  }),

  profileAnalysis: internalProcedure.input(profileAnalysisInput).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return { summary: buildCaptureProfileAnalytics([]), rows: [], totalMatches: 0, truncated: false, filters: { cities: [], states: [], salesRooms: [], vehicleBrands: [], vehicleModels: [], travelSeasons: [], relationshipStatuses: [] } };
    const conditions = [];
    // LGPD: a análise de perfil traz CPF, renda e notas; para a sala, só fichas dentro da vista (mesma regra da lista).
    if (!canOpenArchivedSheet(ctx.user.role)) conditions.push(roomVisibleCondition(await roomVisibilityCutoff())!);
    if (input.startDate) conditions.push(gte(captureRecords.createdAt, new Date(`${input.startDate}T00:00:00Z`)));
    if (input.endDate) conditions.push(lt(captureRecords.createdAt, new Date(new Date(`${input.endDate}T00:00:00Z`).getTime() + 86_400_000)));
    if (input.campaignId) conditions.push(eq(captureRecords.campaignId, input.campaignId));
    if (input.resortId) conditions.push(eq(captureRecords.resortId, input.resortId));
    if (input.presentationStatus) conditions.push(eq(captureRecords.presentationStatus, input.presentationStatus));
    if (input.city) conditions.push(eq(customers.city, input.city));
    if (input.state) conditions.push(eq(customers.state, input.state));
    if (input.salesRoom) conditions.push(eq(captureRecords.salesRoom, input.salesRoom));
    if (input.captureLocation) conditions.push(like(captureRecords.captureLocation, `%${input.captureLocation}%`));
    if (input.vehicleBrand) conditions.push(like(captureRecords.vehicleBrand, `%${input.vehicleBrand}%`));
    if (input.vehicleModel) conditions.push(like(captureRecords.vehicleModel, `%${input.vehicleModel}%`));
    if (input.relationshipStatus) conditions.push(eq(captureRecords.relationshipStatus, input.relationshipStatus));
    if (input.travelSeason) conditions.push(like(captureRecords.usualTravelSeason, `%${input.travelSeason}%`));
    if (input.qualificationStatus) conditions.push(eq(captureRecords.qualificationStatus, input.qualificationStatus));
    if (input.vehicleYearMin !== undefined) conditions.push(gte(captureRecords.vehicleYear, input.vehicleYearMin));
    if (input.vehicleYearMax !== undefined) conditions.push(lte(captureRecords.vehicleYear, input.vehicleYearMax));
    if (input.childrenMin !== undefined) conditions.push(gte(captureRecords.childrenCount, input.childrenMin));
    if (input.childrenMax !== undefined) conditions.push(lte(captureRecords.childrenCount, input.childrenMax));
    if (input.incomeMin !== undefined) conditions.push(gte(captureRecords.averageIncome, input.incomeMin.toFixed(2)));
    if (input.incomeMax !== undefined) conditions.push(lte(captureRecords.averageIncome, input.incomeMax.toFixed(2)));
    if (input.hotelSpendMin !== undefined) conditions.push(gte(captureRecords.averageHotelSpend, input.hotelSpendMin.toFixed(2)));
    if (input.hotelSpendMax !== undefined) conditions.push(lte(captureRecords.averageHotelSpend, input.hotelSpendMax.toFixed(2)));
    if (input.travelWeeksMin !== undefined) conditions.push(gte(captureRecords.travelWeeksPerYear, input.travelWeeksMin.toFixed(1)));
    if (input.travelWeeksMax !== undefined) conditions.push(lte(captureRecords.travelWeeksPerYear, input.travelWeeksMax.toFixed(1)));
    if (input.hasCreditCard !== undefined) conditions.push(eq(captureRecords.hasCreditCard, input.hasCreditCard));
    if (input.acceptsCheque !== undefined) conditions.push(eq(captureRecords.acceptsCheque, input.acceptsCheque));
    if (input.ownsHome !== undefined) conditions.push(eq(captureRecords.ownsHome, input.ownsHome));
    if (input.ownsPropertyInCity !== undefined) conditions.push(eq(captureRecords.ownsPropertyInCity, input.ownsPropertyInCity));
    if (input.isPasserby !== undefined) conditions.push(eq(captureRecords.isPasserby, input.isPasserby));
    if (input.search) {
      const searchLike = `%${input.search}%`;
      conditions.push(or(
        like(customers.fullName, searchLike), like(customers.documentNumber, searchLike), like(customers.email, searchLike), like(customers.phone, searchLike), like(customers.city, searchLike), like(customers.state, searchLike),
        like(captureRecords.lodgingLocation, searchLike), like(captureRecords.transportation, searchLike), like(captureRecords.partnerName, searchLike), like(captureRecords.partnerProfession, searchLike), like(captureRecords.relationshipStatus, searchLike), like(captureRecords.childrenNames, searchLike),
        like(captureRecords.vehicleBrand, searchLike), like(captureRecords.vehicleModel, searchLike), like(captureRecords.creditCardBrands, searchLike), like(captureRecords.usualTravelSeason, searchLike), like(captureRecords.dreamTrips, searchLike), like(captureRecords.lastTrip, searchLike),
        like(captureRecords.nextFamilyTrip, searchLike), like(captureRecords.socialNetworks, searchLike), like(captureRecords.giftDescription, searchLike), like(captureRecords.qualificationReason, searchLike), like(captureRecords.notes, searchLike), like(captureRecords.salesRoom, searchLike), like(captureRecords.captureLocation, searchLike),
      ));
    }
    const profileDatasetLimit = 20_000;
    const rows = await db.select({ capture: captureRecords, customer: customers, campaign: salesCampaigns, resort: resorts, opportunity: opportunities }).from(captureRecords)
      .innerJoin(customers, eq(captureRecords.customerId, customers.id))
      .leftJoin(salesCampaigns, eq(captureRecords.campaignId, salesCampaigns.id))
      .leftJoin(resorts, eq(captureRecords.resortId, resorts.id))
      .leftJoin(opportunities, eq(captureRecords.opportunityId, opportunities.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(captureRecords.createdAt)).limit(profileDatasetLimit);
    const profiles: CaptureProfile[] = rows.map(row => ({
      id: row.capture.id, createdAt: row.capture.createdAt, customerName: row.customer.fullName, customerDocumentNumber: row.customer.documentNumber, customerEmail: row.customer.email, customerPhone: row.customer.phone,
      city: row.customer.city, state: row.customer.state, resortId: row.capture.resortId, resortName: row.resort?.name ?? null, promoterId: row.capture.promoterId, qualifierId: row.capture.qualifierId, linerId: row.capture.linerId, closerId: row.capture.closerId, roomManagerId: row.capture.roomManagerId,
      campaignId: row.capture.campaignId, campaignName: row.campaign?.name ?? null, salesRoom: row.capture.salesRoom, captureLocation: row.capture.captureLocation, lodgingLocation: row.capture.lodgingLocation, transportation: row.capture.transportation, isPasserby: row.capture.isPasserby,
      scheduledAt: row.capture.scheduledAt, presentationStatus: row.capture.presentationStatus, qualificationStatus: row.capture.qualificationStatus, partnerName: row.capture.partnerName, partnerAge: row.capture.partnerAge, partnerProfession: row.capture.partnerProfession, relationshipStatus: row.capture.relationshipStatus,
      relationshipYears: row.capture.relationshipYears, relationshipMonths: row.capture.relationshipMonths, childrenCount: row.capture.childrenCount, childrenNames: row.capture.childrenNames, averageIncome: row.capture.averageIncome === null ? null : Number(row.capture.averageIncome), vehicleBrand: row.capture.vehicleBrand, vehicleModel: row.capture.vehicleModel, vehicleYear: row.capture.vehicleYear,
      hasCreditCard: row.capture.hasCreditCard, creditCardBrands: row.capture.creditCardBrands, acceptsCheque: row.capture.acceptsCheque, ownsHome: row.capture.ownsHome, ownsPropertyInCity: row.capture.ownsPropertyInCity, travelWeeksPerYear: row.capture.travelWeeksPerYear === null ? null : Number(row.capture.travelWeeksPerYear), usualTravelSeason: row.capture.usualTravelSeason,
      dreamTrips: row.capture.dreamTrips, lastTrip: row.capture.lastTrip, averageHotelSpend: row.capture.averageHotelSpend === null ? null : Number(row.capture.averageHotelSpend), nextFamilyTrip: row.capture.nextFamilyTrip, socialNetworks: row.capture.socialNetworks, giftDescription: row.capture.giftDescription, qualificationReason: row.capture.qualificationReason, notes: row.capture.notes,
      opportunityStage: row.opportunity?.stage ?? null, checkedInAt: row.capture.checkedInAt, presentationStartedAt: row.capture.presentationStartedAt,
    }));
    const filtered = profiles;
    const unique = (values: Array<string | null | undefined>) => Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim())))).sort((left, right) => left.localeCompare(right, "pt-BR"));
    return { summary: buildCaptureProfileAnalytics(filtered), rows: filtered.slice(0, input.limit).map(profile => ({ ...profile, readiness: getProfileCompleteness(profile) })), totalMatches: filtered.length, truncated: rows.length >= profileDatasetLimit || filtered.length > input.limit, filters: { cities: unique(profiles.map(profile => profile.city)), states: unique(profiles.map(profile => profile.state)), salesRooms: unique(profiles.map(profile => profile.salesRoom)), vehicleBrands: unique(profiles.map(profile => profile.vehicleBrand)), vehicleModels: unique(profiles.map(profile => profile.vehicleModel)), travelSeasons: unique(profiles.map(profile => profile.usualTravelSeason)), relationshipStatuses: unique(profiles.map(profile => profile.relationshipStatus)) } };
  }),

  create: salesProcedure.input(captureInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const result = await db.transaction(async tx => {
      // Campos com dicionário: só valores da lista, gravados com a grafia dela.
      Object.assign(input, await canonicalizeMasterData(tx, input));
      const [campaignRows, resortRows] = await Promise.all([
        input.campaignId ? tx.select({ id: salesCampaigns.id }).from(salesCampaigns).where(eq(salesCampaigns.id, input.campaignId)).limit(1) : Promise.resolve([]),
        input.resortId ? tx.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1) : Promise.resolve([]),
      ]);
      if (input.campaignId && !campaignRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Campanha da captação não encontrada." });
      if (input.resortId && !resortRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento da captação não encontrado." });
      const staffIds = [input.promoterId, input.qualifierId, input.linerId, input.closerId, input.roomManagerId].filter((id): id is number => id !== undefined && id !== null);
      if (staffIds.length) {
        const staffRows = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, Array.from(new Set(staffIds))), inArray(users.role, ["admin", "seller"])));
        if (staffRows.length !== new Set(staffIds).size) throw new TRPCError({ code: "NOT_FOUND", message: "Membro da equipe da captação não encontrado." });
      }
      if (input.resortId) {
        const settings = (await tx.select().from(commercialProjectSettings).where(eq(commercialProjectSettings.resortId, input.resortId)).limit(1))[0];
        const readiness = getProjectCaptureReadiness({ customerName: input.customer?.fullName, phone: input.customer?.phone, city: input.customer?.city, promoterId: input.promoterId, captureLocation: input.captureLocation, averageIncome: input.averageIncome, travelWeeksPerYear: input.travelWeeksPerYear, qualificationStatus: input.qualificationStatus, vehicle: input.vehicleBrand || input.vehicleModel, homeOwnership: input.ownsHome === true ? "sim" : null }, settings?.requiredCaptureFields);
        if (readiness.missing.some(field => field === "Veículo" || field === "Moradia")) throw new TRPCError({ code: "BAD_REQUEST", message: `Ficha incompleta para este empreendimento: ${readiness.missing.join(", ")}.` });
      }
      let customerId = input.customerId;
      let customerName = "Associado";
      if (customerId) {
        const existingCustomer = (await tx.select({ id: customers.id, fullName: customers.fullName, anonymizedAt: customers.anonymizedAt }).from(customers).where(eq(customers.id, customerId)).limit(1).for("update"))[0];
        if (!existingCustomer) throw new TRPCError({ code: "NOT_FOUND", message: "Associado da captação não encontrado." });
        if (existingCustomer.anonymizedAt) throw anonymizedCustomerError();
        customerName = existingCustomer.fullName;
      }
      if (!customerId && input.customer) {
        const matches = [];
        if (nullIfBlank(input.customer.documentNumber)) matches.push(eq(customers.documentNumber, nullIfBlank(input.customer.documentNumber)!));
        if (nullIfBlank(input.customer.email)) matches.push(eq(customers.email, nullIfBlank(input.customer.email)!));
        if (nullIfBlank(input.customer.phone)) matches.push(eq(customers.phone, nullIfBlank(input.customer.phone)!));
        const existing = matches.length ? (await tx.select().from(customers).where(or(...matches)).limit(1).for("update"))[0] : undefined;
        if (existing?.anonymizedAt) throw anonymizedCustomerError();
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
        if (!opportunityId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a oportunidade da captação." });
      }
      const appointmentPlan = getCaptureAppointmentPlan({ customerName, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, salesRoom: input.salesRoom });
      const inserted = await tx.insert(captureRecords).values({
        customerId, resortId: clean(input.resortId), opportunityId, campaignId: clean(input.campaignId), promoterId: clean(input.promoterId), qualifierId: clean(input.qualifierId), linerId: clean(input.linerId), closerId: clean(input.closerId), roomManagerId: clean(input.roomManagerId), salesRoom: nullIfBlank(input.salesRoom), captureLocation: nullIfBlank(input.captureLocation), lodgingLocation: nullIfBlank(input.lodgingLocation), transportation: nullIfBlank(input.transportation), isPasserby: input.isPasserby, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, presentationStatus: appointmentPlan.presentationStatus, qualificationStatus: input.qualificationStatus, qualificationReason: nullIfBlank(input.qualificationReason), partnerName: nullIfBlank(input.partnerName), partnerAge: clean(input.partnerAge), partnerProfession: nullIfBlank(input.partnerProfession), partnerProfessionNotes: nullIfBlank(input.partnerProfessionNotes), relationshipStatus: nullIfBlank(input.relationshipStatus), relationshipYears: clean(input.relationshipYears), relationshipMonths: clean(input.relationshipMonths), childrenCount: input.childrenCount, childrenNames: nullIfBlank(input.childrenNames), primaryProfessionNotes: nullIfBlank(input.primaryProfessionNotes), averageIncome: input.averageIncome?.toFixed(2) ?? null, vehicleBrand: nullIfBlank(input.vehicleBrand), vehicleModel: nullIfBlank(input.vehicleModel), vehicleYear: clean(input.vehicleYear), hasCreditCard: clean(input.hasCreditCard), creditCardBrands: nullIfBlank(input.creditCardBrands), acceptsCheque: clean(input.acceptsCheque), ownsHome: clean(input.ownsHome), ownsPropertyInCity: clean(input.ownsPropertyInCity), travelWeeksPerYear: input.travelWeeksPerYear?.toFixed(1) ?? null, usualTravelSeason: nullIfBlank(input.usualTravelSeason), dreamTrips: nullIfBlank(input.dreamTrips), lastTrip: nullIfBlank(input.lastTrip), averageHotelSpend: input.averageHotelSpend?.toFixed(2) ?? null, nextFamilyTrip: nullIfBlank(input.nextFamilyTrip), socialNetworks: nullIfBlank(input.socialNetworks), giftDescription: nullIfBlank(input.giftDescription), notes: nullIfBlank(input.notes) }).$returningId();
      const captureId = inserted[0]?.id;
      if (!captureId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registrar a ficha de captação." });
      if (input.guestpassPassRef) {
        if (!isGuestpassPrefillEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Busca de passe desligada." });
        const passRef = normalizePassRef(input.guestpassPassRef);
        if (!passRef) throw new TRPCError({ code: "BAD_REQUEST", message: "Nº do passe inválido. Use o formato GP-XXXXXXXX." });
        try { await linkGuestpassToCapture(tx, { captureId, passRef, actorUserId: ctx.user.id, fetchedAt: sanitizeFetchedAt(input.guestpassFetchedAt) }); }
        catch (error) {
          if (error instanceof GuestpassLinkConflict) throw new TRPCError({ code: "CONFLICT", message: "Este passe já está vinculado a outra ficha." });
          throw error;
        }
      }
      let taskId: number | null = null;
      if (appointmentPlan.task) {
        const scheduledTask = await tx.insert(tasks).values({ title: appointmentPlan.task.title, description: appointmentPlan.task.description, type: "follow_up", priority: input.qualificationStatus === "qualified" ? "high" : "normal", customerId, assignedToUserId: clean(input.linerId) ?? clean(input.closerId) ?? ctx.user.id, dueAt: appointmentPlan.task.dueAt, reminderAt: appointmentPlan.task.reminderAt, createdByUserId: ctx.user.id }).$returningId();
        taskId = scheduledTask[0]?.id ?? null;
        if (!taskId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o acompanhamento da captação." });
      }
      return { captureId, customerId, opportunityId, taskId };
    });
    await recordAudit(ctx.user.id, "capture", result.captureId, "created", `Ficha de captação criada para associado ${result.customerId}.`);
    if (result.taskId) await recordAudit(ctx.user.id, "task", result.taskId, "created", `Acompanhamento de captação criado para ficha ${result.captureId}.`);
    await recordDomainEvent({ eventName: "capture.created", aggregateType: "capture", aggregateId: result.captureId, actorUserId: ctx.user.id, payload: { customerId: result.customerId, campaignId: input.campaignId ?? null, qualificationStatus: input.qualificationStatus } });
    if (result.opportunityId) await recordDomainEvent({ eventName: "opportunity.created", aggregateType: "opportunity", aggregateId: result.opportunityId, actorUserId: ctx.user.id, payload: { customerId: result.customerId, stage: input.qualificationStatus === "qualified" ? "qualified" : "new", campaignId: input.campaignId ?? null } });
    publishSalesRoomEvent({ type: "capture.created", captureId: result.captureId, salesRoom: input.salesRoom });
    return result;
  }),

  updateStatus: salesProcedure.input(z.object({ id: z.number().int().positive(), presentationStatus: z.enum(["captured", "scheduled", "checked_in", "presented", "no_tour", "closed"]), qualificationStatus: z.enum(["pending", "qualified", "disqualified"]).optional(), qualificationReason: optionalText, noTourReason: optionalText })).mutation(async ({ ctx, input }) => {
    // Sem-tour passa pelo motivo padronizado (captures.markNoTour ou captureSheet.recordNt); aqui ele criaria um NT sem classificação.
    if (input.presentationStatus === "no_tour") throw new TRPCError({ code: "BAD_REQUEST", message: "Para marcar sem-tour use o botão de sem-tour da sala ou o cartão de NT da ficha, que pedem o motivo da lista." });
    const { db, capture } = await findCaptureOrThrow(input.id, ctx.user.role);
    if (!canTransitionPresentationStatus(capture.presentationStatus, input.presentationStatus)) throw new TRPCError({ code: "BAD_REQUEST", message: `Transição inválida: ${capture.presentationStatus} → ${input.presentationStatus}.` });
    const updateResult = await db.update(captureRecords).set({ presentationStatus: input.presentationStatus, qualificationStatus: input.qualificationStatus, qualificationReason: nullIfBlank(input.qualificationReason), noTourReason: nullIfBlank(input.noTourReason), checkedInAt: input.presentationStatus === "checked_in" ? new Date() : undefined }).where(and(eq(captureRecords.id, input.id), isNull(captureRecords.anonymizedAt), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    if (affectedRows(updateResult) === 0) throw new TRPCError({ code: "CONFLICT", message: "A ficha de captação foi alterada por outra operação. Recarregue e tente novamente." });
    await recordAudit(ctx.user.id, "capture", input.id, "status_updated", `Captação atualizada para ${input.presentationStatus}.`);
    await recordDomainEvent({ eventName: "capture.status.updated", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { presentationStatus: input.presentationStatus, qualificationStatus: input.qualificationStatus ?? null } });
    publishSalesRoomEvent({ type: "capture.status.updated", captureId: input.id });
    return { success: true };
  }),

  receptionQueue: receptionProcedure.input(z.object({ date: z.string().date().optional(), salesRoom: optionalShort, includeCompleted: z.boolean().default(false) }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const date = input?.date ?? new Date().toISOString().slice(0, 10);
    const start = new Date(`${date}T00:00:00-03:00`);
    const end = new Date(`${date}T23:59:59.999-03:00`);
    // Sem data de visita (ficha antiga ou cadastro rápido), vale o dia em que a ficha foi criada, como em captureSheet.
    const filters = [or(and(gte(captureRecords.scheduledAt, start), lt(captureRecords.scheduledAt, end)), and(isNull(captureRecords.scheduledAt), gte(captureRecords.createdAt, start), lt(captureRecords.createdAt, end)))!];
    if (input?.salesRoom?.trim()) filters.push(eq(captureRecords.salesRoom, input.salesRoom.trim()));
    // LGPD: data passada não abre a ficha de quem não comprou para a sala; admin e finance seguem vendo.
    if (!canOpenArchivedSheet(ctx.user.role)) filters.push(roomVisibleCondition(await roomVisibilityCutoff())!);
    // "captured" sem data é ficha que ainda não foi marcada: aguarda atendimento no dia em que foi criada.
    if (!input?.includeCompleted) filters.push(or(inArray(captureRecords.presentationStatus, activeRoomStatuses), and(isNull(captureRecords.scheduledAt), eq(captureRecords.presentationStatus, "captured")))!);
    const rows = await db.select({ capture: captureRecords, customer: customers, campaign: salesCampaigns }).from(captureRecords)
      .innerJoin(customers, eq(captureRecords.customerId, customers.id))
      .leftJoin(salesCampaigns, eq(captureRecords.campaignId, salesCampaigns.id))
      .where(and(...filters)).orderBy(sql`COALESCE(${captureRecords.scheduledAt}, ${captureRecords.createdAt})`);
    return filterReceptionQueue(rows, { date, salesRoom: input?.salesRoom, includeCompleted: input?.includeCompleted }).map(row => ({ ...row, durationMinutes: tourDurationMinutes(row.capture.presentationStartedAt, row.capture.presentationEndedAt) }));
  }),

  checkIn: receptionProcedure.input(z.object({ id: z.number().int().positive(), receptionNotes: optionalText })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id, ctx.user.role);
    assertAction(capture, "check_in");
    const checkedInAt = new Date();
    const updateResult = await db.update(captureRecords).set({ presentationStatus: "checked_in", checkedInAt, receptionNotes: nullIfBlank(input.receptionNotes) ?? capture.receptionNotes }).where(and(eq(captureRecords.id, input.id), isNull(captureRecords.anonymizedAt), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "checked_in", "Chegada confirmada pela recepção.");
    await recordDomainEvent({ eventName: "capture.checked_in", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom } });
    publishSalesRoomEvent({ type: "capture.checked_in", captureId: input.id, salesRoom: capture.salesRoom });
    return { success: true, checkedInAt };
  }),

  assignRoom: receptionProcedure.input(z.object({ id: z.number().int().positive(), salesTable: z.string().trim().min(1).max(64), linerId: z.number().int().positive().optional().nullable(), closerId: z.number().int().positive().optional().nullable(), roomManagerId: z.number().int().positive().optional().nullable(), receptionNotes: optionalText })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id, ctx.user.role);
    assertAction(capture, "assign_table");
    const staffIds = [input.linerId, input.closerId, input.roomManagerId].filter((id): id is number => id !== undefined && id !== null);
    if (staffIds.length) {
      const uniqueStaffIds = Array.from(new Set(staffIds));
      const staffRows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, uniqueStaffIds), inArray(users.role, ["admin", "seller"])));
      if (staffRows.length !== uniqueStaffIds.length) throw new TRPCError({ code: "NOT_FOUND", message: "Operador da sala não encontrado ou não pertence à equipe comercial." });
    }
    const assignedAt = new Date();
    const updateResult = await db.update(captureRecords).set({ salesTable: input.salesTable, linerId: clean(input.linerId), closerId: clean(input.closerId), roomManagerId: clean(input.roomManagerId), assignedAt, receptionNotes: nullIfBlank(input.receptionNotes) ?? capture.receptionNotes }).where(and(eq(captureRecords.id, input.id), isNull(captureRecords.anonymizedAt), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "room_assigned", `Mesa ${input.salesTable} e equipe da sala atribuídas.`);
    await recordDomainEvent({ eventName: "capture.room.assigned", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, salesTable: input.salesTable, linerId: input.linerId ?? null, closerId: input.closerId ?? null, roomManagerId: input.roomManagerId ?? null } });
    publishSalesRoomEvent({ type: "capture.room.assigned", captureId: input.id, salesRoom: capture.salesRoom });
    return { success: true, assignedAt };
  }),

  startPresentation: receptionProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id, ctx.user.role);
    assertAction(capture, "start_presentation");
    const presentationStartedAt = new Date();
    const updateResult = await db.update(captureRecords).set({ presentationStatus: "presented", presentationStartedAt, presentationEndedAt: null }).where(and(eq(captureRecords.id, input.id), isNull(captureRecords.anonymizedAt), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "presentation_started", `Apresentação iniciada na mesa ${capture.salesTable}.`);
    await recordDomainEvent({ eventName: "capture.presentation.started", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, salesTable: capture.salesTable } });
    publishSalesRoomEvent({ type: "capture.presentation.started", captureId: input.id, salesRoom: capture.salesRoom });
    return { success: true, presentationStartedAt };
  }),

  endPresentation: receptionProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id, ctx.user.role);
    assertAction(capture, "end_presentation");
    const presentationEndedAt = new Date();
    const durationMinutes = tourDurationMinutes(capture.presentationStartedAt, presentationEndedAt);
    const updateResult = await db.update(captureRecords).set({ presentationStatus: "closed", presentationEndedAt }).where(and(eq(captureRecords.id, input.id), isNull(captureRecords.anonymizedAt), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "presentation_ended", `Apresentação concluída e encerrada após ${durationMinutes} minutos.`);
    await recordDomainEvent({ eventName: "capture.presentation.ended", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, salesTable: capture.salesTable, durationMinutes } });
    publishSalesRoomEvent({ type: "capture.presentation.ended", captureId: input.id, salesRoom: capture.salesRoom });
    await eligibilityHookAfterCommit({ captureId: input.id }); // C2/C3: atendimento encerrado (ramo A). Pós-commit, best-effort; flag OFF = no-op.
    return { success: true, presentationEndedAt, durationMinutes };
  }),

  // ADR-007 (V6): resultado comercial da sala. VENDEU = aceite comercial; CAIU EM MESA = motivo obrigatório. Nenhum dos dois
  // é venda validada: não marca oportunidade ganha, não cria contrato nem comissão. Imutável depois de gravado (idempotente se idêntico).
  recordCommercialOutcome: salesProcedure.input(z.object({
    id: z.number().int().positive(),
    outcome: z.enum(["vendeu", "caiu_em_mesa"]),
    reason: z.string().trim().max(5000).optional().nullable(),
    motiveId: z.number().int().positive().optional().nullable(),
  }).superRefine((value, issueContext) => {
    if (value.outcome === "vendeu" && value.motiveId) issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["motiveId"], message: "VENDEU não tem motivo da lista." });
    if (value.outcome === "caiu_em_mesa" && (value.reason?.trim().length ?? 0) < 3 && !value.motiveId) {
      issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Informe o motivo (mínimo 3 caracteres) para CAIU EM MESA." });
    }
  })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id, ctx.user.role);
    // O closer designado grava o próprio resultado; admin (gerente) pode registrar por qualquer ficha.
    if (ctx.user.role !== "admin" && capture.closerId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Somente o closer designado da ficha (ou a administração) registra o resultado comercial." });
    let reason = nullIfBlank(input.reason);
    let motiveId: number | null = null;
    let complement: string | null = null;
    // Já gravado com este motivo: repetir é idempotente mesmo que o motivo tenha sido desativado ou renomeado depois.
    if (capture.commercialOutcome && input.motiveId) {
      const sameComplement = (capture.commercialOutcomeComplement ?? null) === reason;
      if (capture.commercialOutcome === input.outcome && capture.commercialOutcomeMotiveId === input.motiveId && sameComplement) return { success: true as const, alreadyRecorded: true as const, outcome: capture.commercialOutcome };
      throw new TRPCError({ code: "CONFLICT", message: "COMMERCIAL_OUTCOME_IMMUTABLE: o resultado comercial desta ficha já foi registrado e não pode ser alterado." });
    }
    if (input.outcome === "caiu_em_mesa" && input.motiveId) {
      const [motive] = await db.select().from(captureMotives).where(eq(captureMotives.id, input.motiveId)).limit(1);
      if (!motive || !motive.active || motive.kind !== "nt_mesa") throw new TRPCError({ code: "BAD_REQUEST", message: "Motivo inválido para CAIU EM MESA." });
      if (motive.requiresComplement && (reason?.length ?? 0) < 3) throw new TRPCError({ code: "BAD_REQUEST", message: "Este motivo pede um complemento (mínimo 3 caracteres)." });
      motiveId = motive.id;
      complement = reason;
      reason = reason ? `${motive.label}: ${reason}` : motive.label;
    }
    const sameAs = (existing: { commercialOutcome: string | null; commercialOutcomeReason: string | null; commercialOutcomeMotiveId: number | null; commercialOutcomeComplement: string | null }) => existing.commercialOutcome === input.outcome && (input.outcome === "vendeu" || (motiveId !== null ? (existing.commercialOutcomeMotiveId ?? null) === motiveId && (existing.commercialOutcomeComplement ?? null) === complement : (existing.commercialOutcomeReason ?? null) === reason && (existing.commercialOutcomeMotiveId ?? null) === null));
    const rejectChange = () => new TRPCError({ code: "CONFLICT", message: "COMMERCIAL_OUTCOME_IMMUTABLE: o resultado comercial desta ficha já foi registrado e não pode ser alterado." });
    if (capture.commercialOutcome) {
      if (sameAs(capture)) return { success: true as const, alreadyRecorded: true as const, outcome: capture.commercialOutcome };
      throw rejectChange();
    }
    if (capture.presentationStatus !== "presented" && capture.presentationStatus !== "closed") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `COMMERCIAL_OUTCOME_REQUIRES_PRESENTATION: o resultado comercial só pode ser registrado depois que a apresentação começou (atual: ${capture.presentationStatus}).` });
    }
    const recordedAt = new Date();
    const nqPolicyVersion = await qualificationVersionToStamp(db, DEFAULT_NQ_SETTINGS);
    const updateResult = await db.update(captureRecords).set({ ...(nqPolicyVersion ? { nqPolicyVersion } : {}), commercialOutcome: input.outcome, commercialOutcomeReason: reason, commercialOutcomeAt: recordedAt, commercialOutcomeByUserId: ctx.user.id, commercialOutcomeMotiveId: motiveId, commercialOutcomeComplement: complement })
      .where(and(eq(captureRecords.id, input.id), isNull(captureRecords.anonymizedAt), isNull(captureRecords.commercialOutcome)));
    if (affectedRows(updateResult) === 0) {
      const current = (await db.select().from(captureRecords).where(eq(captureRecords.id, input.id)).limit(1))[0];
      if (current?.commercialOutcome && sameAs(current)) return { success: true as const, alreadyRecorded: true as const, outcome: current.commercialOutcome };
      throw rejectChange();
    }
    const label = input.outcome === "vendeu" ? "VENDEU" : "CAIU EM MESA";
    await recordAudit(ctx.user.id, "capture", input.id, "commercial_outcome_recorded", `Resultado comercial ${label} registrado.`);
    await recordDomainEvent({ eventName: "capture.commercial_outcome.recorded", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { outcome: input.outcome } });
    if (input.outcome === "vendeu") await eligibilityHookAfterCommit({ captureId: input.id }); // C2/C3: VENDEU bloqueia (sale_in_progress). Pós-commit, best-effort.
    return { success: true as const, alreadyRecorded: false as const, outcome: input.outcome, recordedAt };
  }),

  // Com `ntKind` + `motiveId` o sem-tour usa o motivo padronizado da lista (captador gravado); sem eles segue o texto livre de antes.
  markNoTour: receptionProcedure.input(z.object({ id: z.number().int().positive(), reason: z.string().trim().max(5000).optional(), ntKind: z.enum(["perfil", "tempo", "consultor"]).optional(), motiveId: z.number().int().positive().optional(), receptionNotes: optionalText }).superRefine((value, issueContext) => {
    if (!value.motiveId !== !value.ntKind) issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["motiveId"], message: "Tipo e motivo do não tour vêm juntos." });
    if (!value.motiveId && (value.reason?.length ?? 0) < 3) issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Informe o motivo (mínimo 3 caracteres)." });
  })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id, ctx.user.role);
    assertAction(capture, "mark_no_tour");
    const complement = nullIfBlank(input.reason);
    const nt = input.motiveId && input.ntKind ? await resolveNtMotive(db, input.ntKind, input.motiveId, complement) : null;
    const finalReason = nt?.reason ?? input.reason!;
    const ntVersion = nt && input.ntKind ? await qualificationVersionToStamp(db, DEFAULT_NQ_SETTINGS) : null;
    const ntColumns = nt && input.ntKind ? { ...(ntVersion ? { nqPolicyVersion: ntVersion } : {}), ntKind: input.ntKind, ntMotiveId: nt.motive.id, ntComplement: complement, ntCaptorName: await captorNameOf(db, capture.id, capture.promoterId), ntRecordedAt: new Date(), ntRecordedByUserId: ctx.user.id } : {};
    const endedAt = new Date();
    const updateResult = await db.update(captureRecords).set({ ...ntColumns, presentationStatus: "no_tour", noTourReason: finalReason, presentationEndedAt: endedAt, receptionNotes: nullIfBlank(input.receptionNotes) ?? capture.receptionNotes }).where(and(eq(captureRecords.id, input.id), isNull(captureRecords.anonymizedAt), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "no_tour", "Captação encerrada sem tour com motivo registrado.");
    await recordDomainEvent({ eventName: "capture.no_tour", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, reason: finalReason } });
    publishSalesRoomEvent({ type: "capture.no_tour", captureId: input.id, salesRoom: capture.salesRoom });
    await eligibilityHookAfterCommit({ captureId: input.id }); // C2/C3: não-tour (ramo B). Pós-commit, best-effort; flag OFF = no-op.
    return { success: true, endedAt };
  }),
});
