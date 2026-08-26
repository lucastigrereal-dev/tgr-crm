import {
  boolean,
  date,
  decimal,
  index,
  int,
  mysqlEnum,
  mysqlTable,
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
  name: varchar("name", { length: 180 }).notNull(),
  city: varchar("city", { length: 120 }),
  state: varchar("state", { length: 2 }),
  status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("resorts_name_unique").on(table.name)]);

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

export const commercialPolicyVersions = mysqlTable("commercial_policy_versions", {
  id: int("id").autoincrement().primaryKey(),
  resortId: int("resortId").notNull().references(() => resorts.id),
  policyType: mysqlEnum("policyType", ["commission", "cancellation", "revenue_quality"]).notNull(),
  version: varchar("version", { length: 80 }).notNull(),
  policyJson: text("policyJson").notNull(),
  effectiveAt: timestamp("effectiveAt").defaultNow().notNull(),
  retiredAt: timestamp("retiredAt"),
  approvedByUserId: int("approvedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("commercial_policy_version_unique").on(table.resortId, table.policyType, table.version),
  index("commercial_policy_effective_idx").on(table.resortId, table.policyType, table.effectiveAt),
]);

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
    noTourReason: text("noTourReason"),
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
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
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
    sellerId: int("sellerId").notNull().references(() => users.id),
    campaignId: int("campaignId").references(() => salesCampaigns.id),
    opportunityId: int("opportunityId").references(() => opportunities.id),
    contractId: int("contractId").references(() => contracts.id),
    sourceInstallmentId: int("sourceInstallmentId").references(() => installments.id),
    commissionRole: mysqlEnum("commissionRole", ["liner", "closer", "ftb"]).default("ftb").notNull(),
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
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("commissions_seller_idx").on(table.sellerId, table.status), index("commissions_campaign_idx").on(table.campaignId), index("commissions_source_installment_idx").on(table.sourceInstallmentId, table.status), index("commissions_contract_status_idx").on(table.contractId, table.status)],
);

export const contracts = mysqlTable(
  "contracts",
  {
    id: int("id").autoincrement().primaryKey(),
    number: varchar("number", { length: 80 }).notNull().unique(),
    customerId: int("customerId").notNull().references(() => customers.id),
    proposalId: int("proposalId").references(() => proposals.id),
    sellerId: int("sellerId").references(() => users.id),
    usageModel: mysqlEnum("usageModel", ["fixed_week", "flexible_week", "points"]).default("fixed_week").notNull(),
    status: mysqlEnum("status", ["draft", "pending_signature", "active", "overdue", "cancelled", "closed"]).default("draft").notNull(),
    totalAmount: decimal("totalAmount", { precision: 14, scale: 2 }).notNull(),
    signedAt: timestamp("signedAt"),
    activatedAt: timestamp("activatedAt"),
    cancelledAt: timestamp("cancelledAt"),
    cancellationReason: text("cancellationReason"),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("contracts_status_idx").on(table.status), index("contracts_customer_idx").on(table.customerId), index("contracts_proposal_status_idx").on(table.proposalId, table.status)],
);

export const contractDocuments = mysqlTable("contract_documents", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  category: varchar("category", { length: 80 }).notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  storageKey: text("storageKey").notNull(),
  signed: boolean("signed").default(false).notNull(),
  uploadedByUserId: int("uploadedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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

export const installments = mysqlTable(
  "installments",
  {
    id: int("id").autoincrement().primaryKey(),
    contractId: int("contractId").notNull().references(() => contracts.id),
    sequence: int("sequence").notNull(),
    dueDate: date("dueDate").notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    status: mysqlEnum("status", ["open", "paid", "overdue", "cancelled", "renegotiated"]).default("open").notNull(),
    paidAt: timestamp("paidAt"),
    paymentMethod: varchar("paymentMethod", { length: 64 }),
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
}, table => [index("billing_gateway_payment_idx").on(table.gatewayProvider, table.gatewayPaymentId), index("billing_installment_status_idx").on(table.installmentId, table.status), uniqueIndex("billing_gateway_reference_unique").on(table.gatewayProvider, table.externalReference)]);

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
  billingRecordId: int("billingRecordId").references(() => billingRecords.id),
  processedAt: timestamp("processedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("payment_gateway_webhook_unique").on(table.gatewayProvider, table.gatewayEventId), index("payment_gateway_webhook_billing_idx").on(table.billingRecordId, table.createdAt)]);

export const installmentRenegotiations = mysqlTable("installment_renegotiations", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  originalInstallmentId: int("originalInstallmentId").notNull().references(() => installments.id),
  originalAmount: decimal("originalAmount", { precision: 14, scale: 2 }).notNull(),
  proposedAmount: decimal("proposedAmount", { precision: 14, scale: 2 }).notNull(),
  proposedDueDate: date("proposedDueDate").notNull(),
  discountAmount: decimal("discountAmount", { precision: 14, scale: 2 }).default("0.00").notNull(),
  notes: text("notes"),
  status: mysqlEnum("status", ["draft", "approved", "applied", "rejected", "cancelled"]).default("draft").notNull(),
  createdByUserId: int("createdByUserId").references(() => users.id),
  approvedByUserId: int("approvedByUserId").references(() => users.id),
  appliedAt: timestamp("appliedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("renegotiations_contract_idx").on(table.contractId, table.status), index("renegotiations_installment_idx").on(table.originalInstallmentId, table.status)]);

export const financialTransactions = mysqlTable(
  "financial_transactions",
  {
    id: int("id").autoincrement().primaryKey(),
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
    createdByUserId: int("createdByUserId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("financial_transactions_status_idx").on(table.status, table.type), index("financial_transactions_campaign_idx").on(table.campaignId, table.status), index("financial_transactions_paid_idx").on(table.status, table.paidAt, table.type)],
);

export const financialPortfolioAssignments = mysqlTable("financial_portfolio_assignments", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  ownerUserId: int("ownerUserId").notNull().references(() => users.id),
  assignedByUserId: int("assignedByUserId").references(() => users.id),
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
  contractId: int("contractId").references(() => contracts.id),
  beneficiaryName: varchar("beneficiaryName", { length: 255 }).notNull(),
  description: text("description"),
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  dueDate: date("dueDate").notNull(),
  status: mysqlEnum("status", ["pending", "paid", "cancelled"]).default("pending").notNull(),
  paidAt: timestamp("paidAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const domainEvents = mysqlTable("domain_events", {
  id: int("id").autoincrement().primaryKey(),
  eventName: varchar("eventName", { length: 120 }).notNull(),
  aggregateType: varchar("aggregateType", { length: 80 }).notNull(),
  aggregateId: varchar("aggregateId", { length: 80 }).notNull(),
  actorUserId: int("actorUserId").references(() => users.id),
  payload: text("payload"),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
}, table => [index("domain_events_aggregate_idx").on(table.aggregateType, table.aggregateId, table.occurredAt), index("domain_events_name_idx").on(table.eventName, table.occurredAt)]);

export const revenueQualityLedger = mysqlTable("revenue_quality_ledger", {
  id: int("id").autoincrement().primaryKey(),
  contractId: int("contractId").notNull().references(() => contracts.id),
  installmentId: int("installmentId").references(() => installments.id),
  commissionId: int("commissionId").references(() => salesCommissions.id),
  domainEventId: int("domainEventId").references(() => domainEvents.id),
  policyVersionId: int("policyVersionId").references(() => commercialPolicyVersions.id),
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
  revertedAt: timestamp("revertedAt"),
  revertedByUserId: int("revertedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("csv_batches_recent_idx").on(table.createdAt, table.status)]);

export const csvImportItems = mysqlTable("csv_import_items", {
  id: int("id").autoincrement().primaryKey(),
  batchId: int("batchId").notNull().references(() => csvImportBatches.id),
  entityType: mysqlEnum("entityType", ["customer", "contract", "resort", "unit"]).notNull(),
  entityId: int("entityId").notNull(),
  action: mysqlEnum("action", ["created", "updated"]).notNull(),
  beforeSnapshot: text("beforeSnapshot"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("csv_items_batch_idx").on(table.batchId)]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
