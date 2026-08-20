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

export const salesCampaigns = mysqlTable("sales_campaigns", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 180 }).notNull(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  description: text("description"),
  startsAt: date("startsAt"),
  endsAt: date("endsAt"),
  commissionRate: decimal("commissionRate", { precision: 5, scale: 2 }).default("0.00").notNull(),
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
  table => [index("customers_name_idx").on(table.fullName), index("customers_document_idx").on(table.documentNumber)],
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
});

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
  table => [index("units_resort_code_idx").on(table.resortId, table.code)],
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
  table => [index("opportunities_stage_idx").on(table.stage), index("opportunities_seller_idx").on(table.sellerId)],
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
});

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
});

export const salesCommissions = mysqlTable(
  "sales_commissions",
  {
    id: int("id").autoincrement().primaryKey(),
    sellerId: int("sellerId").notNull().references(() => users.id),
    campaignId: int("campaignId").references(() => salesCampaigns.id),
    opportunityId: int("opportunityId").references(() => opportunities.id),
    contractId: int("contractId").references(() => contracts.id),
    baseAmount: decimal("baseAmount", { precision: 14, scale: 2 }).notNull(),
    rate: decimal("rate", { precision: 5, scale: 2 }).notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    status: mysqlEnum("status", ["pending", "approved", "paid", "cancelled"]).default("pending").notNull(),
    notes: text("notes"),
    approvedAt: timestamp("approvedAt"),
    paidAt: timestamp("paidAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("commissions_seller_idx").on(table.sellerId, table.status), index("commissions_campaign_idx").on(table.campaignId)],
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
  table => [index("contracts_status_idx").on(table.status), index("contracts_customer_idx").on(table.customerId)],
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
  amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
  dueDate: date("dueDate").notNull(),
  externalReference: varchar("externalReference", { length: 255 }),
  digitableLine: varchar("digitableLine", { length: 255 }),
  pixCopyPaste: text("pixCopyPaste"),
  generatedAt: timestamp("generatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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
    type: mysqlEnum("type", ["income", "expense"]).notNull(),
    category: varchar("category", { length: 120 }).notNull(),
    description: text("description").notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    dueDate: date("dueDate"),
    paidAt: timestamp("paidAt"),
    status: mysqlEnum("status", ["open", "paid", "cancelled"]).default("open").notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("financial_transactions_status_idx").on(table.status, table.type)],
);

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
  table => [index("reservations_unit_dates_idx").on(table.unitId, table.checkIn, table.checkOut), index("reservations_customer_idx").on(table.customerId)],
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
  offeredAt: timestamp("offeredAt"),
  expiresAt: timestamp("expiresAt"),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("waitlist_resort_window_idx").on(table.resortId, table.desiredCheckIn, table.desiredCheckOut, table.status), index("waitlist_customer_idx").on(table.customerId, table.status)]);

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
    completedAt: timestamp("completedAt"),
    createdByUserId: int("createdByUserId").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("tasks_status_due_idx").on(table.status, table.dueAt), index("tasks_assigned_idx").on(table.assignedToUserId)],
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

export const csvImportBatches = mysqlTable("csv_import_batches", {
  id: int("id").autoincrement().primaryKey(),
  kind: mysqlEnum("kind", ["customers", "contracts"]).notNull(),
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
  entityType: mysqlEnum("entityType", ["customer", "contract"]).notNull(),
  entityId: int("entityId").notNull(),
  action: mysqlEnum("action", ["created", "updated"]).notNull(),
  beforeSnapshot: text("beforeSnapshot"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("csv_items_batch_idx").on(table.batchId)]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
