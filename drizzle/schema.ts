import {
  bigint,
  boolean,
  date,
  decimal,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["admin", "seller", "finance", "service", "user"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const savedAnalysisViews = mysqlTable(
  "saved_analysis_views",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    scope: mysqlEnum("scope", ["dashboard"]).default("dashboard").notNull(),
    visibility: mysqlEnum("visibility", ["personal", "shared"]).default("personal").notNull(),
    filtersJson: text("filtersJson").notNull(),
    createdByUserId: int("createdByUserId").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("saved_views_creator_idx").on(table.createdByUserId, table.scope), index("saved_views_visibility_idx").on(table.visibility, table.scope)],
);

export const salesCampaigns = mysqlTable("sales_campaigns", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 180 }).notNull(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  description: text("description"),
  startsAt: date("startsAt"),
  endsAt: date("endsAt"),
  commissionRate: decimal("commissionRate", { precision: 5, scale: 2 }).default("0.00").notNull(),
  targetAmount: decimal("targetAmount", { precision: 14, scale: 2 }).default("0.00").notNull(),
  status: mysqlEnum("status", ["draft", "active", "closed"]).default("draft").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const customers = mysqlTable(
  "customers",
  {
    id: int("id").autoincrement().primaryKey(),
    fullName: varchar("fullName", { length: 255 }).notNull(),
    documentNumber: varchar("documentNumber", { length: 32 }),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 32 }),
    birthDate: date("birthDate"),
    maritalStatus: varchar("maritalStatus", { length: 48 }),
    occupation: varchar("occupation", { length: 120 }),
    zipCode: varchar("zipCode", { length: 12 }),
    address: varchar("address", { length: 255 }),
    addressNumber: varchar("addressNumber", { length: 32 }),
    complement: varchar("complement", { length: 120 }),
    neighborhood: varchar("neighborhood", { length: 120 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 2 }),
    acquisitionSource: varchar("acquisitionSource", { length: 120 }),
    status: mysqlEnum("status", ["active", "inactive", "prospect"]).default("prospect").notNull(),
    notes: text("notes"),
    /** LGPD (CRM-A18): quando o pedido de exclusão foi cumprido. Sobra só o registro mínimo (nome e CPF); o resto do cadastro foi limpo. */
    anonymizedAt: timestamp("anonymizedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("customers_name_idx").on(table.fullName), index("customers_document_idx").on(table.documentNumber), uniqueIndex("customers_document_unique").on(table.documentNumber), index("customers_location_idx").on(table.state, table.city)],
);

export const customerDocuments = mysqlTable("customer_documents", {
  id: int("id").autoincrement().primaryKey(),
  customerId: int("customerId").notNull().references(() => customers.id),
  type: varchar("type", { length: 80 }).notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  storageKey: text("storageKey").notNull(),
  uploadedByUserId: int("uploadedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Contatos adicionais do associado (TSE #28): vários telefones, WhatsApp, e-mails e endereços. O preferencial de telefone e
// e-mail espelha customers.phone/email, que continuam sendo o contato principal usado pelo resto do sistema.
export const customerContacts = mysqlTable(
  "customer_contacts",
  {
    id: int("id").autoincrement().primaryKey(),
    customerId: int("customerId").notNull().references(() => customers.id),
    kind: mysqlEnum("kind", ["phone", "whatsapp", "email", "address"]).notNull(),
    label: varchar("label", { length: 60 }),
    value: varchar("value", { length: 500 }).notNull(),
    isPreferred: boolean("isPreferred").default(false).notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id),
    archivedAt: timestamp("archivedAt"),
    archivedByUserId: int("archivedByUserId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("customer_contacts_customer_idx").on(table.customerId, table.kind)],
);

/**
 * Dicionários de cadastro (TSE #25): listas fechadas para os campos analíticos da ficha de captação. Campo sem nenhuma
 * opção ativa continua livre; com opções, a captação só aceita valores da lista (gravados com a grafia da lista).
 */
export const masterDataOptions = mysqlTable(
  "master_data_options",
  {
    id: int("id").autoincrement().primaryKey(),
    field: mysqlEnum("field", ["captureLocation", "transportation", "vehicleBrand", "partnerProfession"]).notNull(),
    value: varchar("value", { length: 180 }).notNull(),
    normalizedKey: varchar("normalizedKey", { length: 180 }).notNull(),
    active: boolean("active").default(true).notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("master_data_options_field_key_unique").on(table.field, table.normalizedKey)],
);

export const customerInteractions = mysqlTable(
  "customer_interactions",
  {
    id: int("id").autoincrement().primaryKey(),
    customerId: int("customerId").notNull().references(() => customers.id),
    type: mysqlEnum("type", ["call", "whatsapp", "email", "meeting", "note"]).notNull(),
    direction: mysqlEnum("direction", ["incoming", "outgoing", "internal"]).default("internal").notNull(),
    subject: varchar("subject", { length: 255 }),
    content: text("content").notNull(),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id),
  },
  table => [index("interactions_customer_idx").on(table.customerId, table.occurredAt)],
);

export const resorts = mysqlTable("resorts", {
  id: int("id").autoincrement().primaryKey(),
  externalKey: varchar("externalKey", { length: 120 }),
  name: varchar("name", { length: 180 }).notNull(),
  city: varchar("city", { length: 120 }),
  state: varchar("state", { length: 2 }),
  status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("resorts_name_unique").on(table.name),
  uniqueIndex("resorts_external_key_unique").on(table.externalKey),
]);

export const commercialProjectSettings = mysqlTable("commercial_project_settings", {
  id: int("id").autoincrement().primaryKey(),
  resortId: int("resortId").notNull().references(() => resorts.id).unique(),
  cancellationPolicy: text("cancellationPolicy"),
  requiredCaptureFields: text("requiredCaptureFields"),
  requiredContractDocuments: text("requiredContractDocuments"),
  commercialRoles: text("commercialRoles"),
  commissionPolicy: text("commissionPolicy"),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// CRM-G1: política de qualificação (casal qualificado) versionada e GLOBAL, como capture_sheet_settings. Sem retroatividade: a versão vale de effectiveAt em diante.
export const qualificationPolicyVersions = mysqlTable("qualification_policy_versions", {
  id: int("id").autoincrement().primaryKey(),
  version: varchar("version", { length: 80 }).notNull(),
  paramsJson: text("paramsJson").notNull(),
  effectiveAt: timestamp("effectiveAt").defaultNow().notNull(),
  retiredAt: timestamp("retiredAt"),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("qualification_policy_version_unique").on(table.version),
  index("qualification_policy_effective_idx").on(table.effectiveAt),
]);

export const commercialPolicyVersions = mysqlTable("commercial_policy_versions", {
  id: int("id").autoincrement().primaryKey(),
  resortId: int("resortId").notNull().references(() => resorts.id),
  policyType: mysqlEnum("policyType", ["commission", "cancellation", "revenue_quality", "monetary_adjustment", "sale_terms", "stock_hold"]).notNull(),
  version: varchar("version", { length: 80 }).notNull(),
  policyJson: text("policyJson").notNull(),
  effectiveAt: timestamp("effectiveAt").defaultNow().notNull(),
  retiredAt: timestamp("retiredAt"),
  approvedByUserId: int("approvedByUserId").references(() => users.id),
  // CRM-F1: marca as linhas semeadas por migração (ex.: "migration-0076-legacy"); o rollback só apaga estas, nunca versões criadas por pessoas.
  seededBy: varchar("seededBy", { length: 40 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("commercial_policy_version_unique").on(table.resortId, table.policyType, table.version),
  index("commercial_policy_effective_idx").on(table.resortId, table.policyType, table.effectiveAt),
]);

// WP11 (PRD v4 §13): registry de política ABERTA — status e vigência, sem valores. Nenhum motor lê esta tabela;
// os motores continuam em commercial_policy_versions (teste policyRegistryIsolation).
export const policyRegistry = mysqlTable("policy_registry", {
  id: int("id").autoincrement().primaryKey(),
  resortId: int("resortId").notNull().references(() => resorts.id),
  policyType: mysqlEnum("policyType", ["commission", "cancellation_terms", "monetary_index", "delinquency", "retention", "messaging", "consent_final", "contact_hours"]).notNull(),
  version: varchar("version", { length: 80 }).notNull(),
  status: mysqlEnum("status", ["DRAFT", "UNAPPROVED", "APPROVED", "RETIRED"]).default("UNAPPROVED").notNull(),
  validFrom: date("validFrom"),
  validTo: date("validTo"),
  approver: varchar("approver", { length: 160 }),
  receiptRef: varchar("receiptRef", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("policy_registry_version_unique").on(table.resortId, table.policyType, table.version),
  index("policy_registry_status_idx").on(table.resortId, table.status),
]);

export const monetaryIndexValues = mysqlTable(
  "monetary_index_values",
  {
    id: int("id").autoincrement().primaryKey(),
    indexCode: varchar("indexCode", { length: 40 }).notNull(),
    referenceDate: date("referenceDate").notNull(),
    variationPercent: decimal("variationPercent", { precision: 9, scale: 6 }).notNull(),
    source: varchar("source", { length: 255 }).notNull(),
    sourceReference: varchar("sourceReference", { length: 500 }),
    importedByUserId: int("importedByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("monetary_index_values_code_date_unique").on(table.indexCode, table.referenceDate),
    index("monetary_index_values_code_date_idx").on(table.indexCode, table.referenceDate),
    foreignKey({ name: "miv_user_fk", columns: [table.importedByUserId], foreignColumns: [users.id] }),
  ],
);

export const units = mysqlTable(
  "units",
  {
    id: int("id").autoincrement().primaryKey(),
    resortId: int("resortId").notNull().references(() => resorts.id),
    code: varchar("code", { length: 64 }).notNull(),
    category: varchar("category", { length: 100 }),
    capacity: int("capacity").default(2).notNull(),
    beds: int("beds").default(1).notNull(),
    status: mysqlEnum("status", ["active", "maintenance", "inactive"]).default("active").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("units_resort_code_unique").on(table.resortId, table.code)],
);

export const opportunities = mysqlTable(
  "opportunities",
  {
    id: int("id").autoincrement().primaryKey(),
    customerId: int("customerId").notNull().references(() => customers.id),
    sellerId: int("sellerId").references(() => users.id),
    campaignId: int("campaignId").references(() => salesCampaigns.id),
    title: varchar("title", { length: 255 }).notNull(),
    stage: mysqlEnum("stage", ["new", "qualified", "proposal", "negotiation", "won", "lost"]).default("new").notNull(),
    source: varchar("source", { length: 120 }),
    expectedAmount: decimal("expectedAmount", { precision: 14, scale: 2 }).default("0.00").notNull(),
    probability: int("probability").default(10).notNull(),
    nextFollowUpAt: timestamp("nextFollowUpAt"),
    lossReason: text("lossReason"),
    closedAt: timestamp("closedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("opportunities_stage_idx").on(table.stage), index("opportunities_seller_idx").on(table.sellerId), index("opportunities_period_idx").on(table.stage, table.closedAt, table.createdAt), index("opportunities_campaign_period_idx").on(table.campaignId, table.stage, table.closedAt)],
);

export const captureRecords = mysqlTable(
  "capture_records",
  {
    id: int("id").autoincrement().primaryKey(),
    customerId: int("customerId").notNull().references(() => customers.id),
    resortId: int("resortId").references(() => resorts.id),
    opportunityId: int("opportunityId").references(() => opportunities.id),
    campaignId: int("campaignId").references(() => salesCampaigns.id),
    promoterId: int("promoterId").references(() => users.id),
    qualifierId: int("qualifierId").references(() => users.id),
    linerId: int("linerId").references(() => users.id),
    closerId: int("closerId").references(() => users.id),
    roomManagerId: int("roomManagerId").references(() => users.id),
    salesRoom: varchar("salesRoom", { length: 180 }),
    captureLocation: varchar("captureLocation", { length: 180 }),
    lodgingLocation: varchar("lodgingLocation", { length: 180 }),
    transportation: varchar("transportation", { length: 100 }),
    isPasserby: boolean("isPasserby").default(false).notNull(),
    scheduledAt: timestamp("scheduledAt"),
    checkedInAt: timestamp("checkedInAt"),
    salesTable: varchar("salesTable", { length: 64 }),
    assignedAt: timestamp("assignedAt"),
    presentationStartedAt: timestamp("presentationStartedAt"),
    presentationEndedAt: timestamp("presentationEndedAt"),
    receptionNotes: text("receptionNotes"),
    presentationStatus: mysqlEnum("presentationStatus", ["captured", "scheduled", "checked_in", "presented", "no_tour", "closed"]).default("captured").notNull(),
    qualificationStatus: mysqlEnum("qualificationStatus", ["pending", "qualified", "disqualified"]).default("pending").notNull(),
    qualificationReason: text("qualificationReason"),
    // CRM-G1: versão da política de qualificação em vigor quando a sala registrou NT ou o resultado comercial ("legacy" = capture_sheet_settings). Nulável: fichas antigas.
    nqPolicyVersion: varchar("nqPolicyVersion", { length: 80 }),
    noTourReason: text("noTourReason"),
    // ADR-007 (V6): resultado comercial da sala (VENDEU | CAIU EM MESA). Imutável depois de gravado; NÃO é venda validada.
    commercialOutcome: mysqlEnum("commercialOutcome", ["vendeu", "caiu_em_mesa"]),
    commercialOutcomeReason: text("commercialOutcomeReason"),
    commercialOutcomeAt: timestamp("commercialOutcomeAt"),
    commercialOutcomeByUserId: int("commercialOutcomeByUserId").references(() => users.id),
    commercialOutcomeMotiveId: int("commercialOutcomeMotiveId"),
    commercialOutcomeComplement: text("commercialOutcomeComplement"),
    // Não tour (NT) de perfil, tempo ou consultor, com motivo padronizado; o de mesa é o CAIU EM MESA acima. Imutável depois de gravado.
    ntKind: mysqlEnum("ntKind", ["perfil", "tempo", "consultor"]),
    ntMotiveId: int("ntMotiveId"),
    ntComplement: text("ntComplement"),
    ntCaptorName: varchar("ntCaptorName", { length: 180 }),
    ntRecordedAt: timestamp("ntRecordedAt"),
    ntRecordedByUserId: int("ntRecordedByUserId"),
    partnerName: varchar("partnerName", { length: 255 }),
    partnerAge: int("partnerAge"),
    partnerProfession: varchar("partnerProfession", { length: 120 }),
    partnerProfessionNotes: text("partnerProfessionNotes"),
    relationshipStatus: varchar("relationshipStatus", { length: 64 }),
    relationshipYears: int("relationshipYears"),
    relationshipMonths: int("relationshipMonths"),
    childrenCount: int("childrenCount").default(0).notNull(),
    childrenNames: text("childrenNames"),
    primaryProfessionNotes: text("primaryProfessionNotes"),
    averageIncome: decimal("averageIncome", { precision: 14, scale: 2 }),
    vehicleBrand: varchar("vehicleBrand", { length: 100 }),
    vehicleModel: varchar("vehicleModel", { length: 120 }),
    vehicleYear: int("vehicleYear"),
    hasCreditCard: boolean("hasCreditCard"),
    creditCardBrands: text("creditCardBrands"),
    acceptsCheque: boolean("acceptsCheque"),
    ownsHome: boolean("ownsHome"),
    ownsPropertyInCity: boolean("ownsPropertyInCity"),
    travelWeeksPerYear: decimal("travelWeeksPerYear", { precision: 4, scale: 1 }),
    usualTravelSeason: varchar("usualTravelSeason", { length: 180 }),
    dreamTrips: text("dreamTrips"),
    lastTrip: text("lastTrip"),
    averageHotelSpend: decimal("averageHotelSpend", { precision: 14, scale: 2 }),
    nextFamilyTrip: text("nextFamilyTrip"),
    socialNetworks: text("socialNetworks"),
    giftDescription: varchar("giftDescription", { length: 255 }),
    notes: text("notes"),
    /** Ficha impressa (TSE x CRM): código legível do casal (publicCode do Sales Command); a ficha abre por ele. Nunca CPF, telefone ou id sequencial. */
    coupleCode: varchar("coupleCode", { length: 64 }),
    secondVehicleModel: varchar("secondVehicleModel", { length: 120 }),
    secondVehicleYear: int("secondVehicleYear"),
    retiredPrimary: boolean("retiredPrimary"),
    retiredPartner: boolean("retiredPartner"),
    guest1Name: varchar("guest1Name", { length: 180 }),
    guest2Name: varchar("guest2Name", { length: 180 }),
    /** PEP: a ficha guarda a oferta e o resultado. O tempo do PEP (decisão do Lucas, 17/10) chega pelo evento de tempos do Sales Command. */
    pepOffered: boolean("pepOffered"),
    pepOfferedBy: varchar("pepOfferedBy", { length: 180 }),
    pepResult: mysqlEnum("pepResult", ["accepted", "declined"]),
    /** Casal qualificado (regra provisória do Lucas, 17/10): a regra de idade é do homem, então a ficha guarda qual cônjuge é o homem. */
    maleSpouse: mysqlEnum("maleSpouse", ["titular", "conjuge"]),
    /** Só carro vale na qualificação; moto é sempre item de NQ. Tipo separado do ano. */
    vehicleKind: mysqlEnum("vehicleKind", ["carro", "moto", "nenhum"]),
    secondVehicleKind: mysqlEnum("secondVehicleKind", ["carro", "moto", "nenhum"]),
    /** Pesquisa rápida da ficha de papel: já assistiu a uma apresentação voltada a férias. */
    watchedVacationPresentation: boolean("watchedVacationPresentation"),
    /** Tipo de captação (ex.: tour direto). Texto livre curto; lista fechada só se o Lucas mandar. */
    captureKind: varchar("captureKind", { length: 60 }),
    /** LGPD (CRM-A18): ficha anonimizada a pedido do titular; os campos pessoais foram limpos e a ficha não imprime mais. */
    anonymizedAt: timestamp("anonymizedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("captures_couple_code_unique").on(table.coupleCode),
    index("captures_customer_idx").on(table.customerId, table.createdAt),
    index("captures_promoter_status_idx").on(table.promoterId, table.presentationStatus, table.createdAt),
    index("captures_qualifier_status_idx").on(table.qualifierId, table.presentationStatus, table.createdAt),
    index("captures_room_manager_status_idx").on(table.roomManagerId, table.presentationStatus, table.createdAt),
    index("captures_campaign_status_idx").on(table.campaignId, table.presentationStatus),
    index("captures_room_status_idx").on(table.salesRoom, table.presentationStatus, table.scheduledAt),
    index("captures_opportunity_idx").on(table.opportunityId),
    index("captures_created_idx").on(table.createdAt),
    index("captures_vehicle_idx").on(table.vehicleBrand, table.vehicleModel, table.createdAt),
    index("captures_profile_numeric_idx").on(table.childrenCount, table.averageIncome, table.createdAt),
    index("captures_travel_idx").on(table.usualTravelSeason, table.travelWeeksPerYear, table.createdAt),
  ],
);

/** Papéis da equipe da ficha (promotor de telemarketing, líder de marketing, recepção...). Lista editável: papel novo não exige migration. */
export const captureTeamRoles = mysqlTable(
  "capture_team_roles",
  {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 40 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    /** presentation: aparece no atendimento e no tempo; support: apoio (login), fora do tempo da ficha. */
    kind: mysqlEnum("kind", ["presentation", "support"]).default("presentation").notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("capture_team_roles_code_unique").on(table.code)],
);

/** Quem ocupou cada papel na ficha: pessoa com login ou só o nome (promotor sem acesso ao sistema). */
export const captureTeamMembers = mysqlTable(
  "capture_team_members",
  {
    id: int("id").autoincrement().primaryKey(),
    captureId: int("captureId").notNull().references(() => captureRecords.id),
    roleId: int("roleId").notNull().references(() => captureTeamRoles.id),
    userId: int("userId").references(() => users.id),
    personName: varchar("personName", { length: 180 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("capture_team_members_capture_role_unique").on(table.captureId, table.roleId), index("capture_team_members_user_idx").on(table.userId)],
);

/** Tempos de sala recebidos do Sales Command por evento (`encounter.times_recorded.v1`). Só adiciona: cada evento é uma linha; o mais recente por ficha vale. */
export const encounterTimeRecords = mysqlTable("encounter_time_records", {
  id: int("id").autoincrement().primaryKey(),
  eventId: varchar("eventId", { length: 120 }).notNull(),
  captureId: int("captureId").notNull().references(() => captureRecords.id),
  coupleCode: varchar("coupleCode", { length: 64 }).notNull(),
  correlationId: varchar("correlationId", { length: 120 }).notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  waitStartedAt: timestamp("waitStartedAt"),
  waitEndedAt: timestamp("waitEndedAt"),
  consultantStartedAt: timestamp("consultantStartedAt"),
  consultantEndedAt: timestamp("consultantEndedAt"),
  consultantDispensed: boolean("consultantDispensed").default(false).notNull(),
  closerStartedAt: timestamp("closerStartedAt"),
  closerEndedAt: timestamp("closerEndedAt"),
  endedAt: timestamp("endedAt"),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("encounter_time_records_event_unique").on(table.eventId),
  index("encounter_time_records_capture_idx").on(table.captureId, table.occurredAt),
]);

/**
 * C1: registro canônico do casal, vindo de `encounter.attendance_recorded.v1` (Sales -> CRM). Chave: (resort mapeado pelo projeto do Sales, id do casal no Sales).
 * PII mínima: nomes e telefone SÓ em dígitos (o Sales manda texto livre). Guarda o último atendimento encerrado; o histórico fica em attendance_records.
 * PROPOSTA de migration: migrations/proposed/PROPOSED_0079_couple_registry_attendance.sql (a tabela só existe depois do GO; receptor desligado por flag).
 */
export const coupleRegistry = mysqlTable("couple_registry", {
  id: int("id").autoincrement().primaryKey(),
  resortId: int("resortId").notNull().references(() => resorts.id),
  salesCoupleId: varchar("salesCoupleId", { length: 36 }).notNull(),
  coupleCode: varchar("coupleCode", { length: 32 }).notNull(),
  primaryName: varchar("primaryName", { length: 160 }),
  secondaryName: varchar("secondaryName", { length: 160 }),
  phoneDigits: varchar("phoneDigits", { length: 64 }),
  lastEncounterId: varchar("lastEncounterId", { length: 36 }).notNull(),
  lastRevision: int("lastRevision").notNull(),
  lastOutcome: mysqlEnum("lastOutcome", ["SALE_CONFIRMED", "NO_SALE", "CAIU_EM_MESA", "NT"]).notNull(),
  lastReasonCode: varchar("lastReasonCode", { length: 100 }),
  lastClosedAt: timestamp("lastClosedAt", { fsp: 3 }).notNull(),
  encountersCount: int("encountersCount").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("couple_registry_resort_couple_unique").on(table.resortId, table.salesCoupleId),
  index("couple_registry_resort_code_idx").on(table.resortId, table.coupleCode),
  index("couple_registry_phone_idx").on(table.phoneDigits),
]);

/** C1: um registro por evento de atendimento recebido (eventId único; (atendimento, revisão) único). Só adiciona. Sem nome nem telefone. */
export const attendanceRecords = mysqlTable("attendance_records", {
  id: int("id").autoincrement().primaryKey(),
  eventId: varchar("eventId", { length: 36 }).notNull(),
  coupleRegistryId: int("coupleRegistryId").notNull().references(() => coupleRegistry.id),
  encounterId: varchar("encounterId", { length: 36 }).notNull(),
  revision: int("revision").notNull(),
  outcome: mysqlEnum("outcome", ["SALE_CONFIRMED", "NO_SALE", "CAIU_EM_MESA", "NT"]).notNull(),
  reasonCode: varchar("reasonCode", { length: 100 }),
  closedAt: timestamp("closedAt", { fsp: 3 }).notNull(),
  occurredAt: timestamp("occurredAt", { fsp: 3 }).notNull(),
  correlationId: varchar("correlationId", { length: 128 }).notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("attendance_records_event_unique").on(table.eventId),
  uniqueIndex("attendance_records_encounter_revision_unique").on(table.encounterId, table.revision),
  index("attendance_records_couple_idx").on(table.coupleRegistryId, table.closedAt),
]);

/**
 * C2/C3 fatia 2: opt-out de contato do Recovery (append-only, por cliente). PROPOSTA de migration: migrations/proposed/PROPOSED_0080_contact_optouts_eligibility_state.sql
 * (a tabela só existe depois do GO; o receptor fica atrás de RECOVERY_ELIGIBILITY_ENABLED=false).
 */
export const customerContactOptouts = mysqlTable("customer_contact_optouts", {
  id: int("id").autoincrement().primaryKey(),
  customerId: int("customerId").notNull().references(() => customers.id),
  coupleCode: varchar("coupleCode", { length: 64 }).notNull(),
  optedOutAt: timestamp("optedOutAt", { fsp: 3 }).notNull(),
  source: mysqlEnum("source", ["crm_staff", "recovery", "owner_request"]).notNull(),
  eventId: varchar("eventId", { length: 120 }),
  payloadHash: varchar("payloadHash", { length: 64 }),
  reasonCode: varchar("reasonCode", { length: 100 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("customer_contact_optouts_event_unique").on(table.eventId),
  index("customer_contact_optouts_customer_idx").on(table.customerId, table.optedOutAt),
]);

/** C2/C3 fatia 2: projeção da elegibilidade por ficha (linha travada com FOR UPDATE pelos ganchos e pela reconciliação, fatias 3/4). Mesma PROPOSTA 0080. */
export const nonBuyerEligibilityState = mysqlTable("non_buyer_eligibility_state", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  captureId: int("captureId").notNull().references(() => captureRecords.id),
  customerId: int("customerId").notNull().references(() => customers.id),
  eligible: boolean("eligible").default(false).notNull(),
  seq: int("seq").default(0).notNull(),
  lastReason: varchar("lastReason", { length: 40 }),
  lastEmittedAt: timestamp("lastEmittedAt", { fsp: 3 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("non_buyer_eligibility_state_capture_unique").on(table.captureId),
  index("non_buyer_eligibility_state_customer_idx").on(table.customerId),
]);

/** F2.1 (fatia 5): livro de entrega dos eventos non_buyer.* ao Recovery, um por eventId. Sem PII (o corpo com contato é montado no envio). PROPOSTA 0089: só existe depois do GO. */
export const nonBuyerDeliveries = mysqlTable("non_buyer_deliveries", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  eventId: varchar("eventId", { length: 120 }).notNull(),
  captureId: int("captureId").notNull().references(() => captureRecords.id),
  seq: int("seq").notNull(),
  kind: mysqlEnum("kind", ["eligible", "revoked"]).notNull(),
  status: mysqlEnum("status", ["pending", "delivered", "superseded", "suppressed", "rejected"]).default("pending").notNull(),
  reason: varchar("reason", { length: 60 }),
  attempts: int("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("nextAttemptAt", { fsp: 3 }),
  lastHttpStatus: smallint("lastHttpStatus"),
  deliveredAt: timestamp("deliveredAt", { fsp: 3 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("non_buyer_deliveries_event_unique").on(table.eventId),
  index("non_buyer_deliveries_due_idx").on(table.status, table.nextAttemptAt),
  index("non_buyer_deliveries_capture_idx").on(table.captureId, table.kind, table.status),
]);

/** Lista editável e VERSIONADA dos indicadores oficiais do CRM (nome e descrição exibidos; a fórmula continua no código). Append-only: a versão vigente é a maior por código. PROPOSTA 0081. */
export const officialIndicatorVersions = mysqlTable("official_indicator_versions", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  code: varchar("code", { length: 40 }).notNull(),
  version: int("version").notNull(),
  label: varchar("label", { length: 160 }).notNull(),
  description: varchar("description", { length: 500 }).notNull().default(""),
  active: boolean("active").default(true).notNull(),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("official_indicator_versions_code_version_unique").on(table.code, table.version)]);

/** Item 5: mapa de papéis da comissão V2, versionado (append-only; vigente = maior versão). PROPOSTA 0083. */
export const commissionRoleMapVersions = mysqlTable("commission_role_map_versions", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  version: int("version").notNull(),
  roleMap: varchar("roleMap", { length: 255 }).notNull(),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("commission_role_map_versions_version_unique").on(table.version)]);

/** Item 5: mapa fixado por contrato no primeiro lançamento V2 (snapshot; mudar a configuração depois não troca o mapa de contrato em andamento). PROPOSTA 0083. */
export const contractCommissionRoleMaps = mysqlTable("contract_commission_role_maps", {
  contractId: int("contractId").primaryKey().references(() => contracts.id),
  mapVersion: int("mapVersion").notNull(),
  roleMap: varchar("roleMap", { length: 255 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** Item 6: sobrescritas de flags da allow-list (append-only; vigente = a última por flagKey). Quem mudou e quando ficam na própria linha. PROPOSTA 0084. */
export const featureFlagOverrides = mysqlTable("feature_flag_overrides", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  flagKey: varchar("flagKey", { length: 60 }).notNull(),
  enabled: boolean("enabled").notNull(),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("feature_flag_overrides_key_idx").on(table.flagKey, table.id)]);

/** Item 4: sobrescritas de permissão por papel (capacidade/ação), append-only; vigente = maior id por permKey. `roles` é JSON. PROPOSTA 0085. Telas ficam fixas por enquanto. */
export const rolePermissionOverrides = mysqlTable("role_permission_overrides", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  permKey: varchar("permKey", { length: 80 }).notNull(),
  roles: varchar("roles", { length: 120 }).notNull(),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("role_permission_overrides_key_idx").on(table.permKey, table.id)]);

/** Limites provisórios e configuráveis da ficha (casal qualificado, termo de ciência). Nada aqui é regra homologada. */
/** Catálogo de motivos padronizados (NT de perfil, tempo, consultor e mesa; qualificação). Lista provisória até o Lucas mandar a final. */
export const captureMotives = mysqlTable("capture_motives", {
  id: int("id").autoincrement().primaryKey(),
  kind: mysqlEnum("kind", ["nt_perfil", "nt_tempo", "nt_consultor", "nt_mesa", "qualificacao"]).notNull(),
  code: varchar("code", { length: 60 }).notNull(),
  label: varchar("label", { length: 160 }).notNull(),
  requiresComplement: boolean("requiresComplement").default(false).notNull(),
  sortOrder: int("sortOrder").default(0).notNull(),
  active: boolean("active").default(true).notNull(),
  provisional: boolean("provisional").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("capture_motives_kind_code_unique").on(table.kind, table.code)]);

export const captureSheetSettings = mysqlTable("capture_sheet_settings", {
  key: varchar("key", { length: 60 }).primaryKey(),
  value: varchar("value", { length: 255 }).notNull(),
  provisional: boolean("provisional").default(true).notNull(),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/**
 * Cada impressão da ficha: quem, quando e se foi reimpressão. O QR é o mesmo em todas.
 * LGPD (parecer 17/10, A1): o papel tem cadeia de custódia. Recolhido e destruído ficam gravados por impressão;
 * a ficha digital nunca é apagada, só o papel.
 */
export const captureSheetPrints = mysqlTable(
  "capture_sheet_prints",
  {
    id: int("id").autoincrement().primaryKey(),
    captureId: int("captureId").notNull().references(() => captureRecords.id),
    printedByUserId: int("printedByUserId").references(() => users.id),
    reprint: boolean("reprint").default(false).notNull(),
    printedAt: timestamp("printedAt").defaultNow().notNull(),
    collectedAt: timestamp("collectedAt"),
    collectedByUserId: int("collectedByUserId").references(() => users.id),
    destroyedAt: timestamp("destroyedAt"),
    destroyedByUserId: int("destroyedByUserId").references(() => users.id),
    /** Prazo prometido no papel desta impressão (dias após o dia impresso). Nulo = impressão anterior à coluna: vale o prazo configurado hoje. */
    destroyDeadlineDays: int("destroyDeadlineDays"),
  },
  table => [index("capture_sheet_prints_capture_idx").on(table.captureId, table.printedAt), index("capture_sheet_prints_printed_idx").on(table.printedAt, table.destroyedAt)],
);

/**
 * Pedido de exclusão/anonimização do titular (LGPD art. 18, CRM-A18). Dois passos com trilha: o administrativo registra o pedido
 * e só a administração confirma digitando o código do casal. Cumprido, o cadastro e as fichas do cliente ficam só com o registro
 * mínimo (nome e CPF) e `giftDate` guarda a data do brinde (antiduplicidade e defesa em disputa). Nada aqui guarda dado pessoal além do motivo digitado.
 */
export const captureErasureRequests = mysqlTable(
  "capture_erasure_requests",
  {
    id: int("id").autoincrement().primaryKey(),
    captureId: int("captureId").notNull().references(() => captureRecords.id),
    customerId: int("customerId").notNull().references(() => customers.id),
    coupleCode: varchar("coupleCode", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["requested", "completed", "rejected"]).default("requested").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    requestedByUserId: int("requestedByUserId").references(() => users.id),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    decidedByUserId: int("decidedByUserId").references(() => users.id),
    decidedAt: timestamp("decidedAt"),
    decisionNote: varchar("decisionNote", { length: 500 }),
    /** Data do brinde preservada no registro mínimo (primeiro voucher não cancelado do cliente; sem voucher, a criação da ficha). */
    giftDate: timestamp("giftDate"),
    /** Quantas fichas do cliente foram anonimizadas no cumprimento. */
    sheetsAnonymized: int("sheetsAnonymized"),
  },
  table => [index("capture_erasure_requests_capture_idx").on(table.captureId, table.status), index("capture_erasure_requests_customer_idx").on(table.customerId)],
);

/**
 * Voucher/brinde (TSE #31): o que foi prometido ao casal na captação ou depois, com custo, validade e baixa de uso.
 * Nada é apagado: cancelar guarda o motivo; vencido é calculado pela data de validade no dia do projeto.
 */
export const vouchers = mysqlTable(
  "vouchers",
  {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 16 }).notNull(),
    customerId: int("customerId").notNull().references(() => customers.id),
    captureId: int("captureId").references(() => captureRecords.id),
    description: varchar("description", { length: 255 }).notNull(),
    /** Parceiro que entrega o brinde (restaurante, spa, passeio), para conferir o custo com ele. */
    partnerName: varchar("partnerName", { length: 120 }),
    costAmount: decimal("costAmount", { precision: 14, scale: 2 }).default("0.00").notNull(),
    expiresAt: date("expiresAt", { mode: "string" }),
    status: mysqlEnum("status", ["issued", "redeemed", "cancelled"]).default("issued").notNull(),
    issuedByUserId: int("issuedByUserId").references(() => users.id),
    issuedAt: timestamp("issuedAt").defaultNow().notNull(),
    redeemedAt: timestamp("redeemedAt"),
    redeemedByUserId: int("redeemedByUserId").references(() => users.id),
    redeemNote: varchar("redeemNote", { length: 255 }),
    cancelledAt: timestamp("cancelledAt"),
    cancelledByUserId: int("cancelledByUserId").references(() => users.id),
    cancelReason: varchar("cancelReason", { length: 255 }),
    /** Gerado pela tela a cada emissão: reenvio depois de resposta perdida devolve o mesmo voucher. */
    requestId: varchar("requestId", { length: 64 }),
  },
  table => [uniqueIndex("vouchers_code_unique").on(table.code), uniqueIndex("vouchers_request_unique").on(table.requestId), index("vouchers_customer_idx").on(table.customerId), index("vouchers_status_expiry_idx").on(table.status, table.expiresAt), index("vouchers_issued_idx").on(table.issuedAt, table.id)],
);

export const proposals = mysqlTable("proposals", {
  id: int("id").autoincrement().primaryKey(),
  opportunityId: int("opportunityId").notNull().references(() => opportunities.id),
  reference: varchar("reference", { length: 64 }).notNull(),
  productDescription: text("productDescription").notNull(),
  totalAmount: decimal("totalAmount", { precision: 14, scale: 2 }).notNull(),
  downPaymentAmount: decimal("downPaymentAmount", { precision: 14, scale: 2 }).default("0.00").notNull(),
  installmentCount: int("installmentCount").default(1).notNull(),
  status: mysqlEnum("status", ["draft", "sent", "approved", "rejected", "expired"]).default("draft").notNull(),
  expiresAt: date("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("proposals_reference_unique").on(table.reference)]);

export const salesPlaybooks = mysqlTable("sales_playbooks", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 180 }).notNull(),
  stage: mysqlEnum("stage", ["new", "qualified", "proposal", "negotiation", "won", "lost"]).notNull(),
  guidance: text("guidance").notNull(),
  checklist: text("checklist"),
  active: boolean("active").default(true).notNull(),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("playbooks_stage_active_idx").on(table.stage, table.active)]);

export const proposalDiscountApprovals = mysqlTable("proposal_discount_approvals", {
  id: int("id").autoincrement().primaryKey(),
  proposalId: int("proposalId").notNull().references(() => proposals.id),
  requestedByUserId: int("requestedByUserId").notNull().references(() => users.id),
  requestedAmount: decimal("requestedAmount", { precision: 14, scale: 2 }).notNull(),
  approvedAmount: decimal("approvedAmount", { precision: 14, scale: 2 }),
  discountPercent: decimal("discountPercent", { precision: 5, scale: 2 }).notNull(),
  rationale: text("rationale").notNull(),
  status: mysqlEnum("status", ["pending", "approved", "rejected", "cancelled"]).default("pending").notNull(),
  decidedByUserId: int("decidedByUserId").references(() => users.id),
  decisionNotes: text("decisionNotes"),
  decidedAt: timestamp("decidedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("discount_proposal_status_idx").on(table.proposalId, table.status), index("discount_requester_idx").on(table.requestedByUserId, table.status)]);

export const salesGoals = mysqlTable("sales_goals", {
  id: int("id").autoincrement().primaryKey(),
  sellerId: int("sellerId").notNull().references(() => users.id),
  monthReference: date("monthReference").notNull(),
  targetAmount: decimal("targetAmount", { precision: 14, scale: 2 }).notNull(),
  targetContracts: int("targetContracts").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("sales_goals_seller_month_unique").on(table.sellerId, table.monthReference)]);

export const salesCommissions = mysqlTable(
  "sales_commissions",
  {
    id: int("id").autoincrement().primaryKey(),
    idempotencyKey: varchar("idempotencyKey", { length: 128 }),
    sellerId: int("sellerId").notNull().references(() => users.id),
    campaignId: int("campaignId").references(() => salesCampaigns.id),
    opportunityId: int("opportunityId").references(() => opportunities.id),
    contractId: int("contractId").references(() => contracts.id),
    sourceInstallmentId: int("sourceInstallmentId").references(() => installments.id),
    commissionRole: mysqlEnum("commissionRole", ["liner", "closer", "ftb", "promoter"]).default("ftb").notNull(),
    // Versão da regra que calculou a comissão automática; o contrato fica na versão do 1º lançamento (liberar o V2 no meio não mistura políticas).
    ruleVersion: varchar("ruleVersion", { length: 8 }).default("v1").notNull(),
    // CRM-F1: código da versão da política (commercial_policy_versions) que originou a comissão; "legacy" = commercial_project_settings. Nulável: linhas antigas.
    policyVersion: varchar("policyVersion", { length: 80 }),
    baseAmount: decimal("baseAmount", { precision: 14, scale: 2 }).notNull(),
    rate: decimal("rate", { precision: 5, scale: 2 }).notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    status: mysqlEnum("status", ["pending", "approved", "paid", "cancelled"]).default("pending").notNull(),
    lifecycleStatus: varchar("lifecycleStatus", { length: 48 }).default("expected").notNull(),
    paymentMethod: varchar("paymentMethod", { length: 64 }),
    compensatedAt: timestamp("compensatedAt"),
    closingAt: timestamp("closingAt"),
    cancellationDeadlineAt: timestamp("cancellationDeadlineAt"),
    expectedPaymentAt: timestamp("expectedPaymentAt"),
    receivedAt: timestamp("receivedAt"),
    cancelledAt: timestamp("cancelledAt"),
    notes: text("notes"),
    approvedAt: timestamp("approvedAt"),
    paidAt: timestamp("paidAt"),
    // ADR-010: comissão já paga em contrato distratado NÃO é estornada automaticamente; fica na fila manual (gerente/financeiro).
    reversalReviewStatus: mysqlEnum("reversalReviewStatus", ["pending", "resolved"]),
    reversalReviewReason: text("reversalReviewReason"),
    reversalReviewRequestedAt: timestamp("reversalReviewRequestedAt"),
    reversalReviewResolvedAt: timestamp("reversalReviewResolvedAt"),
    reversalReviewResolvedByUserId: int("reversalReviewResolvedByUserId").references(() => users.id),
    reversalReviewNote: text("reversalReviewNote"),
    // Decisão da revisão manual: estornada, compensada em outro lançamento ou dispensada (com lançamento financeiro opcional de referência).
    reversalReviewDecision: mysqlEnum("reversalReviewDecision", ["reversed", "offset", "waived"]),
    reversalReviewFinancialTransactionId: int("reversalReviewFinancialTransactionId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("sales_commissions_idempotency_unique").on(table.idempotencyKey), index("commissions_seller_idx").on(table.sellerId, table.status), index("commissions_campaign_idx").on(table.campaignId), index("commissions_source_installment_idx").on(table.sourceInstallmentId, table.status), index("commissions_contract_status_idx").on(table.contractId, table.status), foreignKey({ name: "sc_reversal_fin_tx_fk", columns: [table.reversalReviewFinancialTransactionId], foreignColumns: [financialTransactions.id] })],
);

export const contracts = mysqlTable(
  "contracts",
  {
    id: int("id").autoincrement().primaryKey(),
    number: varchar("number", { length: 80 }).notNull().unique(),
    externalSource: varchar("externalSource", { length: 64 }),
    externalSaleId: varchar("externalSaleId", { length: 120 }),
    customerId: int("customerId").notNull().references(() => customers.id),
    proposalId: int("proposalId").references(() => proposals.id),
    sellerId: int("sellerId").references(() => users.id),
    // CRM-PK-04 / ADR-011: empreendimento do contrato, gravado na criação. Nulo só em contrato antigo ou importado por CSV sem cota.
    resortId: int("resortId").references(() => resorts.id),
    usageModel: mysqlEnum("usageModel", ["fixed_week", "flexible_week", "points"]).default("fixed_week").notNull(),
    status: mysqlEnum("status", ["draft", "pending_signature", "active", "overdue", "cancelled", "closed"]).default("draft").notNull(),
    totalAmount: decimal("totalAmount", { precision: 14, scale: 2 }).notNull(),
    signedAt: timestamp("signedAt"),
    activatedAt: timestamp("activatedAt"),
    cancelledAt: timestamp("cancelledAt"),
    // CRM-E1: reserva de formalização venceu antes da conferência; a cota voltou ao estoque e o contrato não pode ser validado (refazer a venda).
    inventoryLostAt: timestamp("inventoryLostAt"),
    cancellationReason: text("cancellationReason"),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("contracts_status_idx").on(table.status),
    index("contracts_customer_idx").on(table.customerId),
    index("contracts_resort_idx").on(table.resortId),
    index("contracts_proposal_status_idx").on(table.proposalId, table.status),
    uniqueIndex("contracts_external_sale_unique").on(table.externalSource, table.externalSaleId),
  ],
);

export const contractDocuments = mysqlTable("contract_documents", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  category: varchar("category", { length: 80 }).notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  storageKey: text("storageKey").notNull(),
  signed: boolean("signed").default(false).notNull(),
  // ADR-007 (V6): true só quando o arquivo ASSINADO real está no storage (upload de admin com signed:true). `signed` é só exibição.
  signedArtifact: boolean("signedArtifact").default(false).notNull(),
  uploadedByUserId: int("uploadedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ADR-007 (V6): fato da venda VALIDADA. Uma linha por contrato; contrato `active` só nasce da validação final.
export const saleValidations = mysqlTable("sale_validations", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull(),
  paymentConfirmedAt: timestamp("paymentConfirmedAt"),
  paymentConfirmedByUserId: int("paymentConfirmedByUserId"),
  paymentConfirmationNote: text("paymentConfirmationNote"),
  paymentEvidenceRef: varchar("paymentEvidenceRef", { length: 512 }),
  // CRM-B1: documentação conferida pelo administrativo autorizado (o comprovante conferido segue em paymentConfirmed*). Nulo = ainda não conferida.
  documentsConferredAt: timestamp("documentsConferredAt"),
  documentsConferredByUserId: int("documentsConferredByUserId"),
  documentsConferredNote: text("documentsConferredNote"),
  validatedAt: timestamp("validatedAt"),
  validatedByUserId: int("validatedByUserId"),
  signedDocumentId: int("signedDocumentId"),
  // KAN-31 V6 (0047): instantes de cada portão congelados na validação final + referência opaca do documento
  // (crm-doc:<contrato>:<documento>; nunca URL, token, storageKey ou dado do cliente).
  contractGeneratedAt: timestamp("contractGeneratedAt"),
  contractSignedAt: timestamp("contractSignedAt"),
  documentStoredAt: timestamp("documentStoredAt"),
  documentRef: varchar("documentRef", { length: 200 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("sale_validations_contract_unique").on(table.contractId),
  foreignKey({ name: "sv_contract_fk", columns: [table.contractId], foreignColumns: [contracts.id] }),
  foreignKey({ name: "sv_payment_user_fk", columns: [table.paymentConfirmedByUserId], foreignColumns: [users.id] }),
  foreignKey({ name: "sv_validated_user_fk", columns: [table.validatedByUserId], foreignColumns: [users.id] }),
  foreignKey({ name: "sv_signed_document_fk", columns: [table.signedDocumentId], foreignColumns: [contractDocuments.id] }),
]);

// Trilha append-only POR CÓDIGO (sem triggers: MySQL gerenciado com binlog pode recusar CREATE TRIGGER); server/saleValidationAppendOnly.test.ts
// garante que nenhum caminho faz UPDATE/DELETE. documentRef = referência opaca (crm-doc:<contrato>:<documento>), nunca storageKey/filename.
export const saleValidationEvents = mysqlTable("sale_validation_events", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull(),
  step: mysqlEnum("step", ["payment_confirmed", "final_validated", "validation_rejected"]).notNull(),
  actorUserId: int("actorUserId").notNull(),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  beforeJson: text("beforeJson"),
  afterJson: text("afterJson"),
  reason: text("reason"),
  documentRef: varchar("documentRef", { length: 512 }),
  correlationId: varchar("correlationId", { length: 120 }).notNull(),
  externalSaleId: varchar("externalSaleId", { length: 120 }), // KAN-31 V6 (0047): venda do Sales Command (mesmo tamanho de contracts.externalSaleId)
}, table => [
  index("sve_contract_idx").on(table.contractId, table.occurredAt),
  foreignKey({ name: "sve_contract_fk", columns: [table.contractId], foreignColumns: [contracts.id] }),
  foreignKey({ name: "sve_actor_fk", columns: [table.actorUserId], foreignColumns: [users.id] }),
]);

export const contractCancellationRequests = mysqlTable("contract_cancellation_requests", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  status: mysqlEnum("status", ["requested", "approved", "rejected", "executed", "cancelled"]).default("requested").notNull(),
  reason: text("reason").notNull(),
  simulationSnapshot: text("simulationSnapshot").notNull(),
  requestedByUserId: int("requestedByUserId").notNull().references(() => users.id),
  decidedByUserId: int("decidedByUserId").references(() => users.id),
  decisionNotes: text("decisionNotes"),
  decidedAt: timestamp("decidedAt"),
  executedAt: timestamp("executedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("cancellation_requests_contract_status_idx").on(table.contractId, table.status), index("cancellation_requests_status_idx").on(table.status, table.createdAt)]);

export const commercialFractions = mysqlTable(
  "commercial_fractions",
  {
    id: int("id").autoincrement().primaryKey(),
    resortId: int("resortId").notNull(),
    unitId: int("unitId").notNull(),
    code: varchar("code", { length: 96 }).notNull(),
    sequence: int("sequence").notNull(),
    status: mysqlEnum("status", ["available", "held", "sold", "blocked"]).default("available").notNull(),
    currentProposalId: int("currentProposalId"),
    currentContractId: int("currentContractId"),
    listPrice: decimal("listPrice", { precision: 14, scale: 2 }),
    priceTableVersion: varchar("priceTableVersion", { length: 80 }),
    heldUntil: timestamp("heldUntil"),
    blockedReason: text("blockedReason"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("commercial_fractions_resort_code_unique").on(table.resortId, table.code),
    uniqueIndex("commercial_fractions_unit_sequence_unique").on(table.unitId, table.sequence),
    index("commercial_fractions_resort_status_idx").on(table.resortId, table.status),
    index("commercial_fractions_proposal_status_idx").on(table.currentProposalId, table.status),
    index("commercial_fractions_contract_status_idx").on(table.currentContractId, table.status),
    foreignKey({ name: "cf_resort_fk", columns: [table.resortId], foreignColumns: [resorts.id] }),
    foreignKey({ name: "cf_unit_fk", columns: [table.unitId], foreignColumns: [units.id] }),
    foreignKey({ name: "cf_proposal_fk", columns: [table.currentProposalId], foreignColumns: [proposals.id] }),
    foreignKey({ name: "cf_contract_fk", columns: [table.currentContractId], foreignColumns: [contracts.id] }),
  ],
);

export const commercialFractionHolds = mysqlTable(
  "commercial_fraction_holds",
  {
    id: int("id").autoincrement().primaryKey(),
    fractionId: int("fractionId").notNull(),
    proposalId: int("proposalId"),
    // CRM-E1: nulo quando o hold nasce da ingestão do Sales (sem usuário do CRM).
    heldByUserId: int("heldByUserId"),
    // CRM-E1: 'negotiation' (reserva manual) ou 'formalization' (cota presa ao contrato até comprovante+documentação conferidos).
    purpose: mysqlEnum("purpose", ["negotiation", "formalization"]).default("negotiation").notNull(),
    contractId: int("contractId"),
    activeKey: varchar("activeKey", { length: 128 }),
    status: mysqlEnum("status", ["active", "released", "expired", "consumed"]).default("active").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    releasedAt: timestamp("releasedAt"),
    releaseReason: varchar("releaseReason", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("commercial_fraction_holds_active_key_unique").on(table.activeKey),
    index("commercial_fraction_holds_fraction_status_idx").on(table.fractionId, table.status, table.expiresAt),
    index("commercial_fraction_holds_proposal_status_idx").on(table.proposalId, table.status),
    // CRM-PK-11: o job de vencimento busca holds ativos vencidos sem filtrar por cota.
    index("commercial_fraction_holds_status_expires_idx").on(table.status, table.expiresAt),
    foreignKey({ name: "cfh_fraction_fk", columns: [table.fractionId], foreignColumns: [commercialFractions.id] }),
    foreignKey({ name: "cfh_proposal_fk", columns: [table.proposalId], foreignColumns: [proposals.id] }),
    foreignKey({ name: "cfh_user_fk", columns: [table.heldByUserId], foreignColumns: [users.id] }),
  ],
);

export const commercialFractionHistory = mysqlTable(
  "commercial_fraction_history",
  {
    id: int("id").autoincrement().primaryKey(),
    fractionId: int("fractionId").notNull(),
    fromStatus: varchar("fromStatus", { length: 32 }),
    toStatus: varchar("toStatus", { length: 32 }).notNull(),
    proposalId: int("proposalId"),
    contractId: int("contractId"),
    actorUserId: int("actorUserId"),
    reason: varchar("reason", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("commercial_fraction_history_fraction_idx").on(table.fractionId, table.createdAt),
    index("commercial_fraction_history_contract_idx").on(table.contractId, table.createdAt),
    foreignKey({ name: "cfhist_fraction_fk", columns: [table.fractionId], foreignColumns: [commercialFractions.id] }),
    foreignKey({ name: "cfhist_proposal_fk", columns: [table.proposalId], foreignColumns: [proposals.id] }),
    foreignKey({ name: "cfhist_contract_fk", columns: [table.contractId], foreignColumns: [contracts.id] }),
    foreignKey({ name: "cfhist_user_fk", columns: [table.actorUserId], foreignColumns: [users.id] }),
  ],
);

export const contractMonetaryAdjustments = mysqlTable(
  "contract_monetary_adjustments",
  {
    id: int("id").autoincrement().primaryKey(),
    contractId: int("contractId").notNull(),
    policyVersionId: int("policyVersionId").notNull(),
    indexCode: varchar("indexCode", { length: 40 }).notNull(),
    baseDate: date("baseDate").notNull(),
    throughDate: date("throughDate").notNull(),
    periodicityMonths: int("periodicityMonths").notNull(),
    spreadMonthlyPercent: decimal("spreadMonthlyPercent", { precision: 7, scale: 4 }).default("0.0000").notNull(),
    indexFactor: decimal("indexFactor", { precision: 18, scale: 10 }).notNull(),
    spreadFactor: decimal("spreadFactor", { precision: 18, scale: 10 }).notNull(),
    totalFactor: decimal("totalFactor", { precision: 18, scale: 10 }).notNull(),
    beforeTotal: decimal("beforeTotal", { precision: 14, scale: 2 }).notNull(),
    afterTotal: decimal("afterTotal", { precision: 14, scale: 2 }).notNull(),
    calculationJson: text("calculationJson").notNull(),
    appliedByUserId: int("appliedByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("contract_adjustment_contract_through_unique").on(table.contractId, table.throughDate),
    index("contract_adjustment_contract_created_idx").on(table.contractId, table.createdAt),
    index("contract_adjustment_policy_idx").on(table.policyVersionId, table.createdAt),
    foreignKey({ name: "cma_contract_fk", columns: [table.contractId], foreignColumns: [contracts.id] }),
    foreignKey({ name: "cma_policy_fk", columns: [table.policyVersionId], foreignColumns: [commercialPolicyVersions.id] }),
    foreignKey({ name: "cma_user_fk", columns: [table.appliedByUserId], foreignColumns: [users.id] }),
  ],
);

export const contractSignatureEnvelopes = mysqlTable(
  "contract_signature_envelopes",
  {
    id: int("id").autoincrement().primaryKey(),
    contractId: int("contractId").notNull(),
    provider: varchar("provider", { length: 32 }).default("clicksign").notNull(),
    externalEnvelopeId: varchar("externalEnvelopeId", { length: 128 }),
    activeKey: varchar("activeKey", { length: 160 }),
    name: varchar("name", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["draft", "running", "closed", "canceled", "error"]).default("draft").notNull(),
    lastEventName: varchar("lastEventName", { length: 120 }),
    lastEventAt: timestamp("lastEventAt"),
    activatedAt: timestamp("activatedAt"),
    closedAt: timestamp("closedAt"),
    canceledAt: timestamp("canceledAt"),
    createdByUserId: int("createdByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("signature_envelope_provider_external_unique").on(table.provider, table.externalEnvelopeId),
    uniqueIndex("signature_envelope_active_key_unique").on(table.activeKey),
    index("signature_envelope_contract_status_idx").on(table.contractId, table.status),
    foreignKey({ name: "cse_contract_fk", columns: [table.contractId], foreignColumns: [contracts.id] }),
    foreignKey({ name: "cse_user_fk", columns: [table.createdByUserId], foreignColumns: [users.id] }),
  ],
);

export const contractSignatureDocuments = mysqlTable(
  "contract_signature_documents",
  {
    id: int("id").autoincrement().primaryKey(),
    envelopeId: int("envelopeId").notNull(),
    contractDocumentId: int("contractDocumentId").notNull(),
    externalDocumentId: varchar("externalDocumentId", { length: 128 }).notNull(),
    status: mysqlEnum("status", ["pending", "signed", "closed", "canceled"]).default("pending").notNull(),
    signedAt: timestamp("signedAt"),
    closedAt: timestamp("closedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("signature_document_envelope_contractdoc_unique").on(table.envelopeId, table.contractDocumentId),
    uniqueIndex("signature_document_external_unique").on(table.externalDocumentId),
    foreignKey({ name: "csd_envelope_fk", columns: [table.envelopeId], foreignColumns: [contractSignatureEnvelopes.id] }),
    foreignKey({ name: "csd_contractdoc_fk", columns: [table.contractDocumentId], foreignColumns: [contractDocuments.id] }),
  ],
);

export const contractSignatureSigners = mysqlTable(
  "contract_signature_signers",
  {
    id: int("id").autoincrement().primaryKey(),
    envelopeId: int("envelopeId").notNull(),
    customerId: int("customerId"),
    externalSignerId: varchar("externalSignerId", { length: 128 }).notNull(),
    name: varchar("name", { length: 180 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    documentation: varchar("documentation", { length: 32 }),
    status: mysqlEnum("status", ["pending", "signed", "refused", "canceled"]).default("pending").notNull(),
    signedAt: timestamp("signedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("signature_signer_envelope_external_unique").on(table.envelopeId, table.externalSignerId),
    index("signature_signer_customer_status_idx").on(table.customerId, table.status),
    foreignKey({ name: "css_envelope_fk", columns: [table.envelopeId], foreignColumns: [contractSignatureEnvelopes.id] }),
    foreignKey({ name: "css_customer_fk", columns: [table.customerId], foreignColumns: [customers.id] }),
  ],
);

export const signatureWebhookEvents = mysqlTable(
  "signature_webhook_events",
  {
    id: int("id").autoincrement().primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull(),
    eventKey: varchar("eventKey", { length: 160 }).notNull(),
    eventName: varchar("eventName", { length: 120 }).notNull(),
    externalEnvelopeId: varchar("externalEnvelopeId", { length: 128 }),
    externalDocumentId: varchar("externalDocumentId", { length: 128 }),
    payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
    occurredAt: timestamp("occurredAt"),
    processedAt: timestamp("processedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("signature_webhook_provider_event_unique").on(table.provider, table.eventKey),
    index("signature_webhook_envelope_created_idx").on(table.externalEnvelopeId, table.createdAt),
  ],
);

export const installments = mysqlTable(
  "installments",
  {
    id: int("id").autoincrement().primaryKey(),
    contractId: int("contractId").notNull().references(() => contracts.id),
    sequence: int("sequence").notNull(),
    dueDate: date("dueDate").notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    paidAmount: decimal("paidAmount", { precision: 14, scale: 2 }).default("0.00").notNull(),
    status: mysqlEnum("status", ["open", "paid", "overdue", "cancelled", "renegotiated"]).default("open").notNull(),
    paidAt: timestamp("paidAt"),
    paymentMethod: varchar("paymentMethod", { length: 64 }),
    // CRM-H1: o que sustenta o "pago". receipt_claimed = recebimento declarado (comprovante/baixa manual/entrada informada pelo Sales); gateway_confirmed = webhook do gateway; bank_reconciled = conciliado com o extrato.
    settlementEvidence: mysqlEnum("settlementEvidence", ["receipt_claimed", "gateway_confirmed", "bank_reconciled"]).default("receipt_claimed").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("installments_contract_idx").on(table.contractId), index("installments_due_idx").on(table.status, table.dueDate)],
);

export const billingRecords = mysqlTable("billing_records", {
  id: int("id").autoincrement().primaryKey(),
  installmentId: int("installmentId").notNull().references(() => installments.id),
  type: mysqlEnum("type", ["boleto", "pix", "card", "transfer"]).default("boleto").notNull(),
  status: mysqlEnum("status", ["pending", "generated", "paid", "expired", "cancelled"]).default("pending").notNull(),
  gatewayProvider: mysqlEnum("gatewayProvider", ["manual", "asaas"]).default("manual").notNull(),
  gatewayPaymentId: varchar("gatewayPaymentId", { length: 128 }),
  gatewayStatus: varchar("gatewayStatus", { length: 64 }),
  idempotencyKey: varchar("idempotencyKey", { length: 200 }),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  dueDate: date("dueDate").notNull(),
  externalReference: varchar("externalReference", { length: 255 }),
  digitableLine: varchar("digitableLine", { length: 255 }),
  pixCopyPaste: text("pixCopyPaste"),
  pixQrCodeBase64: text("pixQrCodeBase64"),
  invoiceUrl: text("invoiceUrl"),
  bankSlipUrl: text("bankSlipUrl"),
  generatedAt: timestamp("generatedAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("billing_gateway_payment_idx").on(table.gatewayProvider, table.gatewayPaymentId), index("billing_installment_status_idx").on(table.installmentId, table.status), uniqueIndex("billing_gateway_reference_unique").on(table.gatewayProvider, table.externalReference), uniqueIndex("billing_idempotency_unique").on(table.idempotencyKey)]);

export const paymentGatewayCustomers = mysqlTable("payment_gateway_customers", {
  id: int("id").autoincrement().primaryKey(),
  customerId: int("customerId").notNull().references(() => customers.id),
  gatewayProvider: mysqlEnum("gatewayProvider", ["asaas"]).notNull(),
  gatewayCustomerId: varchar("gatewayCustomerId", { length: 128 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("payment_gateway_customer_unique").on(table.customerId, table.gatewayProvider), uniqueIndex("payment_gateway_external_unique").on(table.gatewayProvider, table.gatewayCustomerId)]);

export const paymentGatewayWebhookEvents = mysqlTable("payment_gateway_webhook_events", {
  id: int("id").autoincrement().primaryKey(),
  gatewayProvider: mysqlEnum("gatewayProvider", ["asaas"]).notNull(),
  gatewayEventId: varchar("gatewayEventId", { length: 128 }).notNull(),
  eventType: varchar("eventType", { length: 96 }).notNull(),
  billingRecordId: int("billingRecordId"),
  processedAt: timestamp("processedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("payment_gateway_webhook_unique").on(table.gatewayProvider, table.gatewayEventId),
  index("payment_gateway_webhook_billing_idx").on(table.billingRecordId, table.createdAt),
  foreignKey({ name: "pg_webhook_billing_fk", columns: [table.billingRecordId], foreignColumns: [billingRecords.id] }),
]);

// CRM-A10: intenção durável de emissão no gateway. Gravada ANTES da chamada remota (fora da
// transação de emissão) para que uma cobrança criada no Asaas e não persistida localmente
// possa ser recuperada. Sem FK de propósito: a gravação ocorre enquanto a parcela está travada.
export const paymentGatewayIssueIntents = mysqlTable("payment_gateway_issue_intents", {
  id: int("id").autoincrement().primaryKey(),
  gatewayProvider: mysqlEnum("gatewayProvider", ["asaas"]).notNull(),
  installmentId: int("installmentId").notNull(),
  type: mysqlEnum("type", ["boleto", "pix"]).notNull(),
  externalReference: varchar("externalReference", { length: 255 }).notNull(),
  status: mysqlEnum("status", ["pending", "recorded", "recovered", "abandoned", "manual_review"]).default("pending").notNull(),
  gatewayPaymentId: varchar("gatewayPaymentId", { length: 128 }),
  attempts: int("attempts").default(0).notNull(),
  lastError: varchar("lastError", { length: 255 }),
  actorUserId: int("actorUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("pg_issue_intent_unique").on(table.gatewayProvider, table.installmentId, table.type),
  index("pg_issue_intent_status_idx").on(table.status, table.updatedAt),
]);

// CRM-A12 / ADR-012: aditivo contratual NÃO monetário, mínimo. Nasce desligado (CONTRACT_ADDENDUM_ENABLED). Só `signed` produz efeito; nunca mexe em valor, parcela ou comissão.
export const contractAddenda = mysqlTable("contract_addenda", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  kind: mysqlEnum("kind", ["clause", "contact"]).notNull(),
  status: mysqlEnum("status", ["draft", "awaiting_signature", "signed", "cancelled"]).default("draft").notNull(),
  reason: text("reason").notNull(),
  // clause: {"text": "..."}; contact: {"before": {...}, "after": {...}} com phone/email (antes preenchido no pedido, depois definido no pedido).
  payload: text("payload").notNull(),
  requestedByUserId: int("requestedByUserId").notNull().references(() => users.id),
  signedDocumentId: int("signedDocumentId").references(() => contractDocuments.id),
  decidedByUserId: int("decidedByUserId").references(() => users.id),
  decidedAt: timestamp("decidedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("contract_addenda_contract_idx").on(table.contractId, table.status), uniqueIndex("contract_addenda_signed_document_unique").on(table.signedDocumentId)]);

// CRM-A01: mapa empreendimento -> projeto do Financial. Só vale com FINANCIAL_PROJECT_MAP_ENABLED=true; sem linha (ou inativa), o contrato usa o projeto padrão (env).
export const financialProjectMap = mysqlTable("financial_project_map", {
  id: int("id").autoincrement().primaryKey(),
  resortId: int("resortId").notNull().references(() => resorts.id),
  externalKey: varchar("externalKey", { length: 64 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).default("America/Recife").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("financial_project_map_resort_unique").on(table.resortId)]);

export const installmentRenegotiations = mysqlTable("installment_renegotiations", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  originalInstallmentId: int("originalInstallmentId").notNull(),
  originalAmount: decimal("originalAmount", { precision: 14, scale: 2 }).notNull(),
  proposedAmount: decimal("proposedAmount", { precision: 14, scale: 2 }).notNull(),
  proposedDueDate: date("proposedDueDate").notNull(),
  discountAmount: decimal("discountAmount", { precision: 14, scale: 2 }).default("0.00").notNull(),
  notes: text("notes"),
  status: mysqlEnum("status", ["draft", "approved", "applied", "rejected", "cancelled"]).default("draft").notNull(),
  createdByUserId: int("createdByUserId"),
  approvedByUserId: int("approvedByUserId"),
  appliedAt: timestamp("appliedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  index("renegotiations_contract_idx").on(table.contractId, table.status),
  index("renegotiations_installment_idx").on(table.originalInstallmentId, table.status),
  // nomes curtos reais (0006): o nome padrão passaria de 64 caracteres
  foreignKey({ name: "reneg_orig_installment_fk", columns: [table.originalInstallmentId], foreignColumns: [installments.id] }),
  foreignKey({ name: "reneg_created_user_fk", columns: [table.createdByUserId], foreignColumns: [users.id] }),
  foreignKey({ name: "reneg_approved_user_fk", columns: [table.approvedByUserId], foreignColumns: [users.id] }),
]);

export const financialTransactions = mysqlTable(
  "financial_transactions",
  {
    id: int("id").autoincrement().primaryKey(),
    idempotencyKey: varchar("idempotencyKey", { length: 128 }),
    contractId: int("contractId").references(() => contracts.id),
    campaignId: int("campaignId").references(() => salesCampaigns.id),
    type: mysqlEnum("type", ["income", "expense"]).notNull(),
    category: varchar("category", { length: 120 }).notNull(),
    description: text("description").notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    dueDate: date("dueDate"),
    paidAt: timestamp("paidAt"),
    status: mysqlEnum("status", ["open", "paid", "cancelled"]).default("open").notNull(),
    reconciliationReference: varchar("reconciliationReference", { length: 255 }),
    reconciledAt: timestamp("reconciledAt"),
    reconciledByUserId: int("reconciledByUserId").references(() => users.id),
    // CRM-H1: vínculo EXPLÍCITO lançamento -> parcela (baixa manual e webhook). A conciliação só promove a evidência da parcela vinculada; nunca infere por valor.
    installmentId: int("installmentId"),
    createdByUserId: int("createdByUserId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("financial_transactions_installment_idx").on(table.installmentId), index("financial_transactions_status_idx").on(table.status, table.type), index("financial_transactions_campaign_idx").on(table.campaignId, table.status), index("financial_transactions_paid_idx").on(table.status, table.paidAt, table.type), uniqueIndex("financial_transactions_idempotency_unique").on(table.idempotencyKey)],
);

export const financialPortfolioAssignments = mysqlTable("financial_portfolio_assignments", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  ownerUserId: int("ownerUserId").notNull().references(() => users.id),
  assignedByUserId: int("assignedByUserId").references(() => users.id),
  paidAmountBaseline: decimal("paidAmountBaseline", { precision: 14, scale: 2 }).default("0.00").notNull(),
  startsAt: timestamp("startsAt").defaultNow().notNull(),
  endsAt: timestamp("endsAt"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("portfolio_contract_active_idx").on(table.contractId, table.endsAt),
  index("portfolio_owner_active_idx").on(table.ownerUserId, table.endsAt),
]);

export const financialTransfers = mysqlTable("financial_transfers", {
  id: int("id").autoincrement().primaryKey(),
  idempotencyKey: varchar("idempotencyKey", { length: 128 }),
  contractId: int("contractId").references(() => contracts.id),
  beneficiaryName: varchar("beneficiaryName", { length: 255 }).notNull(),
  description: text("description"),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  dueDate: date("dueDate").notNull(),
  status: mysqlEnum("status", ["pending", "paid", "cancelled"]).default("pending").notNull(),
  paidAt: timestamp("paidAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("financial_transfers_idempotency_unique").on(table.idempotencyKey)]);

export const reservations = mysqlTable(
  "reservations",
  {
    id: int("id").autoincrement().primaryKey(),
    customerId: int("customerId").notNull().references(() => customers.id),
    contractId: int("contractId").references(() => contracts.id),
    unitId: int("unitId").notNull().references(() => units.id),
    checkIn: date("checkIn").notNull(),
    checkOut: date("checkOut").notNull(),
    adults: int("adults").default(1).notNull(),
    children: int("children").default(0).notNull(),
    status: mysqlEnum("status", ["pending", "confirmed", "checked_in", "completed", "cancelled"]).default("pending").notNull(),
    notes: text("notes"),
    createdByUserId: int("createdByUserId").references(() => users.id),
    checkedInAt: timestamp("checkedInAt"),
    checkedOutAt: timestamp("checkedOutAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("reservations_unit_dates_idx").on(table.unitId, table.checkIn, table.checkOut), index("reservations_unit_status_dates_idx").on(table.unitId, table.status, table.checkIn, table.checkOut), index("reservations_customer_idx").on(table.customerId)],
);

export const reservationGuests = mysqlTable(
  "reservation_guests",
  {
    id: int("id").autoincrement().primaryKey(),
    reservationId: int("reservationId").notNull().references(() => reservations.id),
    fullName: varchar("fullName", { length: 255 }).notNull(),
    documentNumber: varchar("documentNumber", { length: 32 }),
    relationship: varchar("relationship", { length: 80 }),
    birthDate: date("birthDate"),
    checkedInAt: timestamp("checkedInAt"),
    checkedOutAt: timestamp("checkedOutAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("reservation_guests_reservation_idx").on(table.reservationId), index("reservation_guests_document_idx").on(table.documentNumber)],
);

export const ownershipEntitlements = mysqlTable("ownership_entitlements", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  resortId: int("resortId").references(() => resorts.id),
  unitId: int("unitId").references(() => units.id),
  entitlementType: mysqlEnum("entitlementType", ["fixed_week", "flexible_week", "points", "exchange"]).notNull(),
  fixedWeek: int("fixedWeek"),
  annualPoints: int("annualPoints").default(0).notNull(),
  priorityLevel: int("priorityLevel").default(1).notNull(),
  validFrom: date("validFrom"),
  validUntil: date("validUntil"),
  status: mysqlEnum("status", ["active", "suspended", "expired", "cancelled"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("entitlements_contract_idx").on(table.contractId), index("entitlements_resort_idx").on(table.resortId, table.status)]);

/**
 * Extrato de pontos (TSE #29): só inclusão. Saldo = soma dos lançamentos; erro se corrige com estorno, nunca editando.
 * idempotencyKey impede creditar o mesmo ano duas vezes e estornar o mesmo lançamento duas vezes.
 */
export const pointsLedger = mysqlTable("points_ledger", {
  id: int("id").autoincrement().primaryKey(),
  entitlementId: int("entitlementId").notNull().references(() => ownershipEntitlements.id),
  entryType: mysqlEnum("entryType", ["annual_credit", "usage", "adjustment", "reversal", "expiration"]).notNull(),
  points: int("points").notNull(),
  referenceYear: int("referenceYear"),
  reservationId: int("reservationId").references(() => reservations.id),
  reversesEntryId: int("reversesEntryId"),
  note: varchar("note", { length: 255 }),
  idempotencyKey: varchar("idempotencyKey", { length: 80 }),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("points_ledger_entitlement_idx").on(table.entitlementId, table.id), uniqueIndex("points_ledger_idempotency_unique").on(table.idempotencyKey)]);

export const unitMaintenanceBlocks = mysqlTable("unit_maintenance_blocks", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId").notNull().references(() => units.id),
  startsAt: date("startsAt").notNull(),
  endsAt: date("endsAt").notNull(),
  reason: varchar("reason", { length: 255 }).notNull(),
  status: mysqlEnum("status", ["planned", "active", "completed", "cancelled"]).default("planned").notNull(),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("maintenance_unit_dates_idx").on(table.unitId, table.startsAt, table.endsAt)]);

export const reservationWaitlist = mysqlTable("reservation_waitlist", {
  id: int("id").autoincrement().primaryKey(),
  customerId: int("customerId").notNull().references(() => customers.id),
  contractId: int("contractId").references(() => contracts.id),
  resortId: int("resortId").references(() => resorts.id),
  desiredCheckIn: date("desiredCheckIn").notNull(),
  desiredCheckOut: date("desiredCheckOut").notNull(),
  partySize: int("partySize").default(1).notNull(),
  priorityScore: int("priorityScore").default(0).notNull(),
  preferenceNotes: text("preferenceNotes"),
  status: mysqlEnum("status", ["waiting", "offered", "confirmed", "expired", "cancelled"]).default("waiting").notNull(),
  activeKey: varchar("activeKey", { length: 255 }),
  offeredAt: timestamp("offeredAt"),
  expiresAt: timestamp("expiresAt"),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("waitlist_resort_window_idx").on(table.resortId, table.desiredCheckIn, table.desiredCheckOut, table.status), index("waitlist_customer_idx").on(table.customerId, table.status), uniqueIndex("waitlist_active_key_unique").on(table.activeKey)]);

export const tasks = mysqlTable(
  "tasks",
  {
    id: int("id").autoincrement().primaryKey(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    type: mysqlEnum("type", ["follow_up", "payment", "reservation", "service", "internal"]).default("internal").notNull(),
    priority: mysqlEnum("priority", ["low", "normal", "high", "urgent"]).default("normal").notNull(),
    status: mysqlEnum("status", ["open", "in_progress", "done", "cancelled"]).default("open").notNull(),
    customerId: int("customerId").references(() => customers.id),
    contractId: int("contractId").references(() => contracts.id),
    assignedToUserId: int("assignedToUserId").references(() => users.id),
    dueAt: timestamp("dueAt"),
    reminderAt: timestamp("reminderAt"),
    automationKey: varchar("automationKey", { length: 255 }),
    completedAt: timestamp("completedAt"),
    createdByUserId: int("createdByUserId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("tasks_status_due_idx").on(table.status, table.dueAt), index("tasks_assigned_idx").on(table.assignedToUserId), uniqueIndex("tasks_automation_key_unique").on(table.automationKey)],
);

export const auditLogs = mysqlTable("audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  actorUserId: int("actorUserId").references(() => users.id),
  entityType: varchar("entityType", { length: 80 }).notNull(),
  entityId: varchar("entityId", { length: 80 }).notNull(),
  action: varchar("action", { length: 80 }).notNull(),
  summary: text("summary"),
  idempotencyKey: varchar("idempotencyKey", { length: 200 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("audit_logs_idempotency_unique").on(table.idempotencyKey), index("audit_logs_entity_type_idx").on(table.entityType, table.id), index("audit_logs_action_idx").on(table.action, table.id)]);

export const domainEvents = mysqlTable("domain_events", {
  id: int("id").autoincrement().primaryKey(),
  eventName: varchar("eventName", { length: 120 }).notNull(),
  aggregateType: varchar("aggregateType", { length: 80 }).notNull(),
  aggregateId: varchar("aggregateId", { length: 80 }).notNull(),
  actorUserId: int("actorUserId").references(() => users.id),
  payload: text("payload"),
  idempotencyKey: varchar("idempotencyKey", { length: 200 }),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
}, table => [index("domain_events_aggregate_idx").on(table.aggregateType, table.aggregateId, table.occurredAt), index("domain_events_name_idx").on(table.eventName, table.occurredAt), uniqueIndex("domain_events_idempotency_unique").on(table.idempotencyKey)]);

export const revenueQualityLedger = mysqlTable("revenue_quality_ledger", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  installmentId: int("installmentId").references(() => installments.id),
  commissionId: int("commissionId").references(() => salesCommissions.id),
  domainEventId: int("domainEventId").references(() => domainEvents.id),
  policyVersionId: int("policyVersionId"),
  factType: mysqlEnum("factType", ["vgv_formalized", "cash_confirmed", "cash_exposure", "revenue_reversed", "cancellation_retention", "cancellation_refund", "commission_expected", "commission_at_risk", "commission_paid", "commission_reversed"]).notNull(),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  reason: varchar("reason", { length: 80 }),
  sourceFingerprint: varchar("sourceFingerprint", { length: 160 }).notNull(),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("revenue_ledger_fingerprint_unique").on(table.sourceFingerprint),
  index("revenue_ledger_contract_fact_idx").on(table.contractId, table.factType, table.occurredAt),
  index("revenue_ledger_policy_idx").on(table.policyVersionId, table.occurredAt),
  foreignKey({ name: "revenue_ledger_policy_fk", columns: [table.policyVersionId], foreignColumns: [commercialPolicyVersions.id] }),
]);

export const csvImportBatches = mysqlTable("csv_import_batches", {
  id: int("id").autoincrement().primaryKey(),
  kind: mysqlEnum("kind", ["customers", "contracts", "units"]).notNull(),
  status: mysqlEnum("status", ["completed", "reverted"]).default("completed").notNull(),
  actorUserId: int("actorUserId").notNull().references(() => users.id),
  totalRows: int("totalRows").default(0).notNull(),
  createdCount: int("createdCount").default(0).notNull(),
  updatedCount: int("updatedCount").default(0).notNull(),
  rejectedCount: int("rejectedCount").default(0).notNull(),
  // Rastreabilidade da origem (Gate 2 da migração): de que sistema/arquivo veio e a impressão digital do conteúdo importado.
  sourceSystem: varchar("sourceSystem", { length: 60 }).default("csv_manual").notNull(),
  sourceFileName: varchar("sourceFileName", { length: 255 }),
  contentHash: varchar("contentHash", { length: 64 }),
  revertedAt: timestamp("revertedAt"),
  revertedByUserId: int("revertedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("csv_batches_recent_idx").on(table.createdAt, table.status), index("csv_batches_content_hash_idx").on(table.contentHash)]);

export const csvImportItems = mysqlTable("csv_import_items", {
  id: int("id").autoincrement().primaryKey(),
  batchId: int("batchId").notNull().references(() => csvImportBatches.id),
  entityType: mysqlEnum("entityType", ["customer", "contract", "resort", "unit"]).notNull(),
  entityId: int("entityId").notNull(),
  action: mysqlEnum("action", ["created", "updated"]).notNull(),
  beforeSnapshot: text("beforeSnapshot"),
  // Linha do arquivo, chave do registro no sistema de origem e hash da linha normalizada.
  sourceLine: int("sourceLine"),
  sourceRecordId: varchar("sourceRecordId", { length: 160 }),
  rowHash: varchar("rowHash", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("csv_items_batch_idx").on(table.batchId), index("csv_items_source_record_idx").on(table.sourceRecordId)]);

// Portal do Proprietário (TSE #19, escopo mínimo): link de leitura gerado pela administração e enviado pelo próprio time.
// Só o hash do token fica no banco; o link expira e pode ser revogado. Uma instalação = uma empresa (decisão de 14/10).
export const ownerPortalLinks = mysqlTable("owner_portal_links", {
  id: int("id").autoincrement().primaryKey(),
  customerId: int("customerId").notNull().references(() => customers.id),
  tokenHash: varchar("tokenHash", { length: 64 }).notNull(),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  expiresAt: timestamp("expiresAt").notNull(),
  revokedAt: timestamp("revokedAt"),
  revokedByUserId: int("revokedByUserId").references(() => users.id),
  lastAccessedAt: timestamp("lastAccessedAt"),
  accessCount: int("accessCount").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("owner_portal_token_unique").on(table.tokenHash), index("owner_portal_customer_idx").on(table.customerId, table.createdAt)]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// CRM-C1: "administrativo autorizado" = papel finance COM concessão vigente (admin concede e revoga). Admin é sempre autorizado.
export const saleValidatorGrants = mysqlTable("sale_validator_grants", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id),
  grantedByUserId: int("grantedByUserId").notNull().references(() => users.id),
  validFrom: timestamp("validFrom").defaultNow().notNull(),
  validUntil: timestamp("validUntil"),
  note: text("note"),
  revokedAt: timestamp("revokedAt"),
  revokedByUserId: int("revokedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("sale_validator_grants_user_idx").on(table.userId, table.revokedAt)]);
