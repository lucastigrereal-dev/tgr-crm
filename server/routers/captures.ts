import { and, desc, eq, gte, inArray, like, lt, lte, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { captureRecords, commercialProjectSettings, customers, opportunities, resorts, salesCampaigns, tasks, users } from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { internalProcedure, receptionProcedure, salesProcedure } from "./access";
import { getCaptureAppointmentPlan, getCaptureReadiness } from "../captureDomain";
import { buildCaptureProfileAnalytics, getProfileCompleteness, profileSearchText, type CaptureProfile } from "../captureSegmentation";
import { getProjectCaptureReadiness } from "../projectPolicy";
import { activeRoomStatuses, assertReceptionAction, filterReceptionQueue, tourDurationMinutes } from "../salesRoomDomain";
import { publishSalesRoomEvent } from "../realtime";

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

function assertCaptureUpdateSucceeded(result: unknown) {
  if (result && typeof result === "object" && "affectedRows" in result && Number(result.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "A ficha de captação foi alterada por outra operação. Recarregue e tente novamente." });
}

export const capturesRouter = router({
  selectors: receptionProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { campaigns: [], sellers: [], resorts: [] };
    const [campaigns, sellers, resortRows] = await Promise.all([
      db.select({ id: salesCampaigns.id, name: salesCampaigns.name, code: salesCampaigns.code, status: salesCampaigns.status }).from(salesCampaigns).orderBy(desc(salesCampaigns.createdAt)).limit(1000),
      db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(or(eq(users.role, "admin"), eq(users.role, "seller"))).orderBy(users.name).limit(1000),
      db.select({ id: resorts.id, name: resorts.name }).from(resorts).orderBy(resorts.name).limit(1000),
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

  profileAnalysis: internalProcedure.input(profileAnalysisInput).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return { summary: buildCaptureProfileAnalytics([]), rows: [], totalMatches: 0, truncated: false, filters: { cities: [], states: [], salesRooms: [], vehicleBrands: [], vehicleModels: [], travelSeasons: [], relationshipStatuses: [] } };
    const conditions = [];
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
    const rows = await db.select({ capture: captureRecords, customer: customers, campaign: salesCampaigns, resort: resorts, opportunity: opportunities }).from(captureRecords)
      .innerJoin(customers, eq(captureRecords.customerId, customers.id))
      .leftJoin(salesCampaigns, eq(captureRecords.campaignId, salesCampaigns.id))
      .leftJoin(resorts, eq(captureRecords.resortId, resorts.id))
      .leftJoin(opportunities, eq(captureRecords.opportunityId, opportunities.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(captureRecords.createdAt)).limit(20_000);
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
    const normalizedSearch = input.search?.toLocaleLowerCase("pt-BR");
    const filtered = profiles.filter(profile => {
      const income = profile.averageIncome ?? -1; const hotelSpend = profile.averageHotelSpend ?? -1; const travelWeeks = profile.travelWeeksPerYear ?? -1; const vehicleYear = profile.vehicleYear ?? -1;
      return (!normalizedSearch || profileSearchText(profile).includes(normalizedSearch)) && (!input.city || profile.city?.toLocaleLowerCase("pt-BR") === input.city.toLocaleLowerCase("pt-BR")) && (!input.state || profile.state === input.state) && (!input.salesRoom || profile.salesRoom === input.salesRoom) && (!input.captureLocation || profile.captureLocation?.toLocaleLowerCase("pt-BR").includes(input.captureLocation.toLocaleLowerCase("pt-BR"))) && (!input.vehicleBrand || profile.vehicleBrand?.toLocaleLowerCase("pt-BR").includes(input.vehicleBrand.toLocaleLowerCase("pt-BR"))) && (!input.vehicleModel || profile.vehicleModel?.toLocaleLowerCase("pt-BR").includes(input.vehicleModel.toLocaleLowerCase("pt-BR"))) && (!input.relationshipStatus || profile.relationshipStatus === input.relationshipStatus) && (!input.travelSeason || profile.usualTravelSeason?.toLocaleLowerCase("pt-BR").includes(input.travelSeason.toLocaleLowerCase("pt-BR"))) && (!input.qualificationStatus || profile.qualificationStatus === input.qualificationStatus) && (input.vehicleYearMin === undefined || vehicleYear >= input.vehicleYearMin) && (input.vehicleYearMax === undefined || vehicleYear <= input.vehicleYearMax) && (input.childrenMin === undefined || profile.childrenCount >= input.childrenMin) && (input.childrenMax === undefined || profile.childrenCount <= input.childrenMax) && (input.incomeMin === undefined || income >= input.incomeMin) && (input.incomeMax === undefined || income <= input.incomeMax) && (input.hotelSpendMin === undefined || hotelSpend >= input.hotelSpendMin) && (input.hotelSpendMax === undefined || hotelSpend <= input.hotelSpendMax) && (input.travelWeeksMin === undefined || travelWeeks >= input.travelWeeksMin) && (input.travelWeeksMax === undefined || travelWeeks <= input.travelWeeksMax) && (input.hasCreditCard === undefined || profile.hasCreditCard === input.hasCreditCard) && (input.acceptsCheque === undefined || profile.acceptsCheque === input.acceptsCheque) && (input.ownsHome === undefined || profile.ownsHome === input.ownsHome) && (input.ownsPropertyInCity === undefined || profile.ownsPropertyInCity === input.ownsPropertyInCity) && (input.isPasserby === undefined || profile.isPasserby === input.isPasserby);
    });
    const unique = (values: Array<string | null | undefined>) => Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim())))).sort((left, right) => left.localeCompare(right, "pt-BR"));
    return { summary: buildCaptureProfileAnalytics(filtered), rows: filtered.slice(0, input.limit).map(profile => ({ ...profile, readiness: getProfileCompleteness(profile) })), totalMatches: filtered.length, truncated: filtered.length > input.limit, filters: { cities: unique(profiles.map(profile => profile.city)), states: unique(profiles.map(profile => profile.state)), salesRooms: unique(profiles.map(profile => profile.salesRoom)), vehicleBrands: unique(profiles.map(profile => profile.vehicleBrand)), vehicleModels: unique(profiles.map(profile => profile.vehicleModel)), travelSeasons: unique(profiles.map(profile => profile.usualTravelSeason)), relationshipStatuses: unique(profiles.map(profile => profile.relationshipStatus)) } };
  }),

  create: salesProcedure.input(captureInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const result = await db.transaction(async tx => {
      const [campaignRows, resortRows] = await Promise.all([
        input.campaignId ? tx.select({ id: salesCampaigns.id }).from(salesCampaigns).where(eq(salesCampaigns.id, input.campaignId)).limit(1) : Promise.resolve([]),
        input.resortId ? tx.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1) : Promise.resolve([]),
      ]);
      if (input.campaignId && !campaignRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Campanha da captação não encontrada." });
      if (input.resortId && !resortRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento da captação não encontrado." });
      const staffIds = [input.promoterId, input.qualifierId, input.linerId, input.closerId, input.roomManagerId].filter((id): id is number => id !== undefined && id !== null);
      if (staffIds.length) {
        const staffRows = await tx.select({ id: users.id }).from(users).where(inArray(users.id, Array.from(new Set(staffIds))));
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
        const existingCustomer = (await tx.select({ id: customers.id, fullName: customers.fullName }).from(customers).where(eq(customers.id, customerId)).limit(1))[0];
        if (!existingCustomer) throw new TRPCError({ code: "NOT_FOUND", message: "Associado da captação não encontrado." });
        customerName = existingCustomer.fullName;
      }
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
        if (!opportunityId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a oportunidade da captação." });
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
    const { db, capture } = await findCaptureOrThrow(input.id);
    const updateResult = await db.update(captureRecords).set({ presentationStatus: input.presentationStatus, qualificationStatus: input.qualificationStatus, qualificationReason: nullIfBlank(input.qualificationReason), noTourReason: nullIfBlank(input.noTourReason), checkedInAt: input.presentationStatus === "checked_in" ? new Date() : undefined }).where(and(eq(captureRecords.id, input.id), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    if (updateResult && typeof updateResult === "object" && "affectedRows" in updateResult && Number(updateResult.affectedRows) === 0) throw new TRPCError({ code: "CONFLICT", message: "A ficha de captação foi alterada por outra operação. Recarregue e tente novamente." });
    await recordAudit(ctx.user.id, "capture", input.id, "status_updated", `Captação atualizada para ${input.presentationStatus}.`);
    await recordDomainEvent({ eventName: "capture.status.updated", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { presentationStatus: input.presentationStatus, qualificationStatus: input.qualificationStatus ?? null } });
    publishSalesRoomEvent({ type: "capture.status.updated", captureId: input.id });
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
    const updateResult = await db.update(captureRecords).set({ presentationStatus: "checked_in", checkedInAt, receptionNotes: nullIfBlank(input.receptionNotes) ?? capture.receptionNotes }).where(and(eq(captureRecords.id, input.id), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "checked_in", "Chegada confirmada pela recepção.");
    await recordDomainEvent({ eventName: "capture.checked_in", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom } });
    publishSalesRoomEvent({ type: "capture.checked_in", captureId: input.id, salesRoom: capture.salesRoom });
    return { success: true, checkedInAt };
  }),

  assignRoom: receptionProcedure.input(z.object({ id: z.number().int().positive(), salesTable: z.string().trim().min(1).max(64), linerId: z.number().int().positive().optional().nullable(), closerId: z.number().int().positive().optional().nullable(), roomManagerId: z.number().int().positive().optional().nullable(), receptionNotes: optionalText })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id);
    assertAction(capture, "assign_table");
    const assignedAt = new Date();
    const updateResult = await db.update(captureRecords).set({ salesTable: input.salesTable, linerId: clean(input.linerId), closerId: clean(input.closerId), roomManagerId: clean(input.roomManagerId), assignedAt, receptionNotes: nullIfBlank(input.receptionNotes) ?? capture.receptionNotes }).where(and(eq(captureRecords.id, input.id), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "room_assigned", `Mesa ${input.salesTable} e equipe da sala atribuídas.`);
    await recordDomainEvent({ eventName: "capture.room.assigned", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, salesTable: input.salesTable, linerId: input.linerId ?? null, closerId: input.closerId ?? null, roomManagerId: input.roomManagerId ?? null } });
    publishSalesRoomEvent({ type: "capture.room.assigned", captureId: input.id, salesRoom: capture.salesRoom });
    return { success: true, assignedAt };
  }),

  startPresentation: receptionProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id);
    assertAction(capture, "start_presentation");
    const presentationStartedAt = new Date();
    const updateResult = await db.update(captureRecords).set({ presentationStatus: "presented", presentationStartedAt, presentationEndedAt: null }).where(and(eq(captureRecords.id, input.id), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "presentation_started", `Apresentação iniciada na mesa ${capture.salesTable}.`);
    await recordDomainEvent({ eventName: "capture.presentation.started", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, salesTable: capture.salesTable } });
    publishSalesRoomEvent({ type: "capture.presentation.started", captureId: input.id, salesRoom: capture.salesRoom });
    return { success: true, presentationStartedAt };
  }),

  endPresentation: receptionProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id);
    assertAction(capture, "end_presentation");
    const presentationEndedAt = new Date();
    const durationMinutes = tourDurationMinutes(capture.presentationStartedAt, presentationEndedAt);
    const updateResult = await db.update(captureRecords).set({ presentationStatus: "closed", presentationEndedAt }).where(and(eq(captureRecords.id, input.id), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "presentation_ended", `Apresentação concluída e encerrada após ${durationMinutes} minutos.`);
    await recordDomainEvent({ eventName: "capture.presentation.ended", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, salesTable: capture.salesTable, durationMinutes } });
    publishSalesRoomEvent({ type: "capture.presentation.ended", captureId: input.id, salesRoom: capture.salesRoom });
    return { success: true, presentationEndedAt, durationMinutes };
  }),

  markNoTour: receptionProcedure.input(z.object({ id: z.number().int().positive(), reason: z.string().trim().min(3).max(5000), receptionNotes: optionalText })).mutation(async ({ ctx, input }) => {
    const { db, capture } = await findCaptureOrThrow(input.id);
    assertAction(capture, "mark_no_tour");
    const endedAt = new Date();
    const updateResult = await db.update(captureRecords).set({ presentationStatus: "no_tour", noTourReason: input.reason, presentationEndedAt: endedAt, receptionNotes: nullIfBlank(input.receptionNotes) ?? capture.receptionNotes }).where(and(eq(captureRecords.id, input.id), eq(captureRecords.presentationStatus, capture.presentationStatus)));
    assertCaptureUpdateSucceeded(updateResult);
    await recordAudit(ctx.user.id, "capture", input.id, "no_tour", "Captação encerrada sem tour com motivo registrado.");
    await recordDomainEvent({ eventName: "capture.no_tour", aggregateType: "capture", aggregateId: input.id, actorUserId: ctx.user.id, payload: { salesRoom: capture.salesRoom, reason: input.reason } });
    publishSalesRoomEvent({ type: "capture.no_tour", captureId: input.id, salesRoom: capture.salesRoom });
    return { success: true, endedAt };
  }),
});
