import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, like, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  contracts,
  customerDocuments,
  customerInteractions,
  captureRecords,
  customers,
  installments,
  opportunities,
  reservations,
  tasks,
} from "../../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "../db";
import { router } from "../_core/trpc";
import { storagePut } from "../storage";
import { internalProcedure } from "./access";
import { buildRelationshipRadar } from "../relationshipRadar";

const customerInput = z.object({
  fullName: z.string().trim().min(3).max(255),
  documentNumber: z.string().trim().max(32).optional().nullable(),
  email: z.string().trim().email().max(320).optional().or(z.literal("")),
  phone: z.string().trim().max(32).optional().nullable(),
  birthDate: z.string().date().optional().nullable(),
  maritalStatus: z.string().trim().max(48).optional().nullable(),
  occupation: z.string().trim().max(120).optional().nullable(),
  zipCode: z.string().trim().max(12).optional().nullable(),
  address: z.string().trim().max(255).optional().nullable(),
  addressNumber: z.string().trim().max(32).optional().nullable(),
  complement: z.string().trim().max(120).optional().nullable(),
  neighborhood: z.string().trim().max(120).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().toUpperCase().max(2).optional().nullable(),
  acquisitionSource: z.string().trim().max(120).optional().nullable(),
  status: z.enum(["active", "inactive", "prospect"]).default("prospect"),
  notes: z.string().trim().max(5000).optional().nullable(),
});

function nullableText(value?: string | null) {
  return value?.trim() ? value.trim() : null;
}

function decodeUpload(base64: string) {
  const payload = base64.includes(",") ? base64.split(",").at(-1)! : base64;
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "O anexo deve ter até 5 MB." });
  }
  return buffer;
}

export const customersRouter = router({
  list: internalProcedure
    .input(z.object({ search: z.string().trim().max(120).optional(), status: z.enum(["active", "inactive", "prospect"]).optional(), city: z.string().trim().max(120).optional(), limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const term = input?.search ? `%${input.search}%` : null;
      const cityTerm = input?.city ? `%${input.city}%` : null;
      return db
        .select()
        .from(customers)
        .where(and(term ? or(like(customers.fullName, term), like(customers.documentNumber, term), like(customers.email, term)) : undefined, input?.status ? eq(customers.status, input.status) : undefined, cityTerm ? like(customers.city, cityTerm) : undefined))
        .orderBy(desc(customers.updatedAt))
        .limit(input?.limit ?? 100);
    }),

  create: internalProcedure.input(customerInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const documentNumber = nullableText(input.documentNumber);
    if (documentNumber) {
      const duplicate = (await db.select({ id: customers.id }).from(customers).where(eq(customers.documentNumber, documentNumber)).limit(1))[0];
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe um cliente com este documento." });
    }
    const inserted = await db.insert(customers).values({
      ...input,
      documentNumber,
      email: nullableText(input.email),
      phone: nullableText(input.phone),
      birthDate: input.birthDate ? new Date(`${input.birthDate}T12:00:00Z`) : null,
      maritalStatus: nullableText(input.maritalStatus),
      occupation: nullableText(input.occupation),
      zipCode: nullableText(input.zipCode),
      address: nullableText(input.address),
      addressNumber: nullableText(input.addressNumber),
      complement: nullableText(input.complement),
      neighborhood: nullableText(input.neighborhood),
      city: nullableText(input.city),
      state: nullableText(input.state),
      acquisitionSource: nullableText(input.acquisitionSource),
      notes: nullableText(input.notes),
    }).$returningId();
    const id = inserted[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar o cliente." });
    await recordAudit(ctx.user.id, "customer", id, "created", `Cliente ${input.fullName} criado.`);
    await recordDomainEvent({ eventName: "customer.created", aggregateType: "customer", aggregateId: id, actorUserId: ctx.user.id, payload: { status: input.status, acquisitionSource: input.acquisitionSource ?? null } });
    return { id };
  }),

  update: internalProcedure.input(z.object({ id: z.number().int().positive(), data: customerInput })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const current = (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.id)).limit(1))[0];
    if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente não encontrado." });
    const documentNumber = nullableText(input.data.documentNumber);
    if (documentNumber) {
      const duplicate = (await db.select({ id: customers.id }).from(customers).where(and(eq(customers.documentNumber, documentNumber), ne(customers.id, input.id))).limit(1))[0];
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Já existe outro cliente com este documento." });
    }
    await db.update(customers).set({
      ...input.data,
      documentNumber,
      email: nullableText(input.data.email),
      phone: nullableText(input.data.phone),
      birthDate: input.data.birthDate ? new Date(`${input.data.birthDate}T12:00:00Z`) : null,
      maritalStatus: nullableText(input.data.maritalStatus),
      occupation: nullableText(input.data.occupation),
      zipCode: nullableText(input.data.zipCode),
      address: nullableText(input.data.address),
      addressNumber: nullableText(input.data.addressNumber),
      complement: nullableText(input.data.complement),
      neighborhood: nullableText(input.data.neighborhood),
      city: nullableText(input.data.city),
      state: nullableText(input.data.state),
      acquisitionSource: nullableText(input.data.acquisitionSource),
      notes: nullableText(input.data.notes),
    }).where(eq(customers.id, input.id));
    await recordAudit(ctx.user.id, "customer", input.id, "updated", `Cadastro de ${input.data.fullName} atualizado.`);
    await recordDomainEvent({ eventName: "customer.updated", aggregateType: "customer", aggregateId: input.id, actorUserId: ctx.user.id, payload: { status: input.data.status, city: input.data.city ?? null, state: input.data.state ?? null } });
    return { success: true };
  }),

  detail: internalProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return null;
    const customer = (await db.select().from(customers).where(eq(customers.id, input.id)).limit(1))[0];
    if (!customer) return null;
    const [interactions, documents, customerContracts, customerOpportunities, customerReservations, customerInstallments, relationshipTasks, captures] = await Promise.all([
      db.select().from(customerInteractions).where(eq(customerInteractions.customerId, input.id)).orderBy(desc(customerInteractions.occurredAt)).limit(50),
      db.select().from(customerDocuments).where(eq(customerDocuments.customerId, input.id)).orderBy(desc(customerDocuments.createdAt)).limit(100),
      db.select().from(contracts).where(eq(contracts.customerId, input.id)).orderBy(desc(contracts.createdAt)).limit(100),
      db.select().from(opportunities).where(eq(opportunities.customerId, input.id)).orderBy(desc(opportunities.updatedAt)).limit(200),
      db.select().from(reservations).where(eq(reservations.customerId, input.id)).orderBy(desc(reservations.checkIn)).limit(200),
      db.select({ status: installments.status }).from(installments).innerJoin(contracts, eq(installments.contractId, contracts.id)).where(eq(contracts.customerId, input.id)).limit(500),
      db.select().from(tasks).where(and(eq(tasks.customerId, input.id), inArray(tasks.status, ["open", "in_progress"]))).orderBy(tasks.dueAt).limit(20),
      db.select().from(captureRecords).where(eq(captureRecords.customerId, input.id)).orderBy(desc(captureRecords.createdAt)).limit(20),
    ]);
    const radar = buildRelationshipRadar({ hasEmail: Boolean(customer.email), hasPhone: Boolean(customer.phone), interactionDates: interactions.map(item => item.occurredAt), documentCount: documents.length, contractStatuses: customerContracts.map(item => item.status), reservationDates: customerReservations.map(item => item.checkIn), installmentStatuses: customerInstallments.map(item => item.status) });
    return { customer, interactions, documents, contracts: customerContracts, opportunities: customerOpportunities, reservations: customerReservations, relationshipTasks, captures, radar };
  }),

  addInteraction: internalProcedure.input(z.object({
    customerId: z.number().int().positive(),
    type: z.enum(["call", "whatsapp", "email", "meeting", "note"]),
    direction: z.enum(["incoming", "outgoing", "internal"]).default("internal"),
    subject: z.string().trim().max(255).optional(),
    content: z.string().trim().min(2).max(5000),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const customer = (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente não encontrado." });
    const result = await db.insert(customerInteractions).values({ ...input, subject: nullableText(input.subject), createdByUserId: ctx.user.id }).$returningId();
    const id = result[0]?.id;
    if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível salvar a interação." });
    await recordAudit(ctx.user.id, "customer_interaction", id, "created", `Interação ${input.type} registrada.`);
    await recordDomainEvent({ eventName: "customer.interaction.created", aggregateType: "customer_interaction", aggregateId: id, actorUserId: ctx.user.id, payload: { customerId: input.customerId, type: input.type, direction: input.direction } });
    return { id };
  }),

  uploadDocument: internalProcedure.input(z.object({
    customerId: z.number().int().positive(),
    category: z.string().trim().min(2).max(80),
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(3).max(120),
    base64: z.string().min(20),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const customer = (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente não encontrado." });
    const buffer = decodeUpload(input.base64);
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const upload = await storagePut(`customers/${input.customerId}/${Date.now()}-${safeName}`, buffer, input.contentType);
    const result = await db.insert(customerDocuments).values({
      customerId: input.customerId,
      type: input.category,
      filename: input.filename,
      storageKey: upload.key,
      uploadedByUserId: ctx.user.id,
    }).$returningId();
    const id = result[0]?.id;
    await recordAudit(ctx.user.id, "customer_document", id ?? 0, "uploaded", `Anexo ${input.filename} incluído.`);
    await recordDomainEvent({ eventName: "customer.document.uploaded", aggregateType: "customer_document", aggregateId: id ?? 0, actorUserId: ctx.user.id, payload: { customerId: input.customerId, category: input.category, filename: input.filename } });
    return { id, url: upload.url };
  }),

  installments: internalProcedure.input(z.object({ customerId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ installment: installments, contractNumber: contracts.number }).from(installments)
      .innerJoin(contracts, eq(installments.contractId, contracts.id))
      .where(eq(contracts.customerId, input.customerId)).orderBy(desc(installments.dueDate)).limit(500);
  }),
});
