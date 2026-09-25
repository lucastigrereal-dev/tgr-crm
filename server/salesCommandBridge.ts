import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, customers, domainEvents, opportunities } from "../drizzle/schema";
import { getDb } from "./db";

const salesCommandSaleSchema = z.strictObject({
  eventId: z.string().trim().min(1).max(120),
  eventName: z.literal("sale.ready_for_contract.v1"),
  source: z.literal("sales-command"),
  correlationId: z.string().trim().min(1).max(120),
  occurredAt: z.string().datetime(),
  project: z.strictObject({
    externalKey: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(160),
    timezone: z.string().trim().min(1).max(80),
  }),
  saleId: z.string().trim().min(1).max(120),
  encounterId: z.string().trim().min(1).max(120),
  customer: z.strictObject({
    name: z.string().trim().min(2).max(255),
    phone: z.string().trim().max(32).optional(),
  }),
  sale: z.strictObject({
    quotasCount: z.number().int().min(1),
    vgvCents: z.number().int().min(0),
    entryContractedCents: z.number().int().min(0),
    entryReceivedCents: z.number().int().min(0),
    entryInstallmentCount: z.number().int().min(1),
    firstBalanceDueInDays: z.number().int().min(0).max(365),
    paymentMethods: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  }),
});

function safeEqual(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

async function handleSalesCommandSale(request: Request, response: Response, integrationKey: string) {
  const authorization = request.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied || !safeEqual(supplied, integrationKey)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = salesCommandSaleSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid event" });
    return;
  }
  const db = await getDb();
  if (!db) {
    response.status(503).json({ error: "Database unavailable" });
    return;
  }
  const event = parsed.data;
  const idempotencyKey = "sales-command:" + event.eventId;
  const existing = (await db.select({ aggregateId: domainEvents.aggregateId, payload: domainEvents.payload })
    .from(domainEvents).where(eq(domainEvents.idempotencyKey, idempotencyKey)).limit(1))[0];
  if (existing) {
    const payload = existing.payload ? JSON.parse(existing.payload) as Record<string, unknown> : {};
    response.status(200).json({
      accepted: true,
      replay: true,
      opportunityId: Number(existing.aggregateId),
      customerId: Number(payload.customerId),
      saleId: event.saleId,
    });
    return;
  }

  const result = await db.transaction(async tx => {
    let customerId: number | undefined;
    if (event.customer.phone) {
      const [matched] = await tx.select({ id: customers.id }).from(customers)
        .where(eq(customers.phone, event.customer.phone)).limit(1);
      customerId = matched?.id;
    }
    if (!customerId) {
      const createdCustomer = await tx.insert(customers).values({
        fullName: event.customer.name,
        phone: event.customer.phone ?? null,
        acquisitionSource: "Sales Command",
        status: "prospect",
        notes: "Criado automaticamente pelo bridge Sales Command → CRM.",
      }).$returningId();
      customerId = createdCustomer[0]?.id;
    }
    if (!customerId) throw new Error("Customer intake failed");

    const createdOpportunity = await tx.insert(opportunities).values({
      customerId,
      title: "Venda Sales Command " + event.saleId.slice(0, 12),
      stage: "proposal",
      source: "Sales Command",
      expectedAmount: (event.sale.vgvCents / 100).toFixed(2),
      probability: 100,
    }).$returningId();
    const opportunityId = createdOpportunity[0]?.id;
    if (!opportunityId) throw new Error("Opportunity intake failed");

    const lineage = {
      customerId,
      saleId: event.saleId,
      encounterId: event.encounterId,
      projectExternalKey: event.project.externalKey,
      projectName: event.project.name,
      projectTimezone: event.project.timezone,
      correlationId: event.correlationId,
      quotasCount: event.sale.quotasCount,
      vgvCents: event.sale.vgvCents,
      entryContractedCents: event.sale.entryContractedCents,
      entryReceivedCents: event.sale.entryReceivedCents,
      entryInstallmentCount: event.sale.entryInstallmentCount,
      firstBalanceDueInDays: event.sale.firstBalanceDueInDays,
      paymentMethods: event.sale.paymentMethods,
    };
    await tx.insert(domainEvents).values({
      eventName: "sales.command.sale.ingested",
      aggregateType: "opportunity",
      aggregateId: String(opportunityId),
      actorUserId: null,
      payload: JSON.stringify(lineage),
      idempotencyKey,
      occurredAt: new Date(event.occurredAt),
    });
    await tx.insert(auditLogs).values({
      actorUserId: null,
      entityType: "opportunity",
      entityId: String(opportunityId),
      action: "sales_command_ingested",
      summary: "Venda confirmada no Sales Command recebida para formalização contratual.",
      idempotencyKey: "audit:" + idempotencyKey,
    });
    return { customerId, opportunityId };
  });

  response.status(201).json({ accepted: true, replay: false, ...result, saleId: event.saleId });
}

export function registerSalesCommandBridge(app: Express, integrationKey: string | undefined) {
  app.post("/api/integrations/sales-command", async (request, response) => {
    const key = integrationKey?.trim();
    if (!key) {
      response.status(503).json({ error: "Integration unavailable" });
      return;
    }
    try {
      await handleSalesCommandSale(request, response, key);
    } catch {
      response.status(503).json({ error: "Event processing failed" });
    }
  });
}
