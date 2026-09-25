import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, contracts, customers, domainEvents } from "../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "./db";
import { fetchWithTimeout } from "./integrationReliability";

const salesEventSchema = z.strictObject({
  eventId: z.string().trim().min(1).max(120),
  eventName: z.literal("sale.ready_for_contract.v1"),
  source: z.literal("sales-command"),
  correlationId: z.string().trim().min(1).max(120),
  occurredAt: z.string().datetime(),
  project: z.strictObject({
    externalKey: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(160),
    timezone: z.string().trim().min(1).max(64).optional(),
  }),
  saleId: z.string().trim().min(1).max(120),
  encounterId: z.string().trim().min(1).max(120),
  customer: z.strictObject({
    name: z.string().trim().min(2).max(255),
    phone: z.string().trim().min(3).max(40).optional(),
    email: z.string().trim().email().max(320).optional(),
  }),
  commercial: z.strictObject({
    quotasCount: z.number().int().positive(),
    vgvCents: z.number().int().nonnegative(),
    entryContractedCents: z.number().int().nonnegative(),
    entryReceivedCents: z.number().int().nonnegative(),
    entryInstallmentCount: z.number().int().positive(),
    firstBalanceDueInDays: z.number().int().min(0).max(365),
    paymentMethods: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  }),
});

export type SalesCommandIntake = z.infer<typeof salesEventSchema> & {
  crmCustomerId: number;
  sourceEventId: string;
};

function safeEqual(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function parsePayload(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseSalesIntake(value: string | null): SalesCommandIntake | null {
  const parsed = parsePayload(value);
  if (!parsed || typeof parsed.crmCustomerId !== "number" || typeof parsed.sourceEventId !== "string") return null;
  const validated = salesEventSchema.safeParse(parsed);
  if (!validated.success) return null;
  return { ...validated.data, crmCustomerId: parsed.crmCustomerId, sourceEventId: parsed.sourceEventId };
}

export class AmbiguousSalesIntakeError extends Error {
  override readonly name = "AmbiguousSalesIntakeError";
}

export async function findSinglePendingSalesIntakeForCustomer(customerId: number): Promise<SalesCommandIntake | null> {
  const db = await getDb();
  if (!db) return null;
  const [received, linked] = await Promise.all([
    db.select({ payload: domainEvents.payload }).from(domainEvents)
      .where(eq(domainEvents.eventName, "sales.intake.received"))
      .orderBy(desc(domainEvents.id)).limit(500),
    db.select({ payload: domainEvents.payload }).from(domainEvents)
      .where(eq(domainEvents.eventName, "sales.intake.linked"))
      .orderBy(desc(domainEvents.id)).limit(500),
  ]);
  const linkedSales = new Set(
    linked.map(row => parsePayload(row.payload)?.saleId).filter((value): value is string => typeof value === "string"),
  );
  const pending = received
    .map(row => parseSalesIntake(row.payload))
    .filter((row): row is SalesCommandIntake => Boolean(row))
    .filter(row => row.crmCustomerId === customerId && !linkedSales.has(row.saleId));
  if (pending.length > 1) {
    throw new AmbiguousSalesIntakeError("Há mais de uma venda do Sales Command aguardando formalização para este cliente.");
  }
  return pending[0] ?? null;
}

export async function linkSalesIntakeToContract(
  contractId: number,
  customerId: number,
  intake: SalesCommandIntake,
  actorUserId: number | null,
) {
  await recordDomainEvent({
    eventName: "sales.intake.linked",
    aggregateType: "contract",
    aggregateId: contractId,
    actorUserId,
    idempotencyKey: `sales-intake-link:${intake.saleId}:${contractId}`,
    payload: {
      saleId: intake.saleId,
      sourceEventId: intake.sourceEventId,
      project: intake.project,
      crmCustomerId: customerId,
      crmContractId: contractId,
      correlationId: intake.correlationId,
    },
  });
}

async function linkedSalesIntakeForContract(contractId: number): Promise<SalesCommandIntake | null> {
  const db = await getDb();
  if (!db) return null;
  const [link] = await db.select({ payload: domainEvents.payload }).from(domainEvents)
    .where(and(eq(domainEvents.eventName, "sales.intake.linked"), eq(domainEvents.aggregateId, String(contractId))))
    .orderBy(desc(domainEvents.id)).limit(1);
  const linkPayload = parsePayload(link?.payload ?? null);
  const saleId = typeof linkPayload?.saleId === "string" ? linkPayload.saleId : null;
  if (!saleId) return null;
  const received = await db.select({ payload: domainEvents.payload }).from(domainEvents)
    .where(and(eq(domainEvents.eventName, "sales.intake.received"), eq(domainEvents.aggregateId, saleId)))
    .orderBy(desc(domainEvents.id)).limit(1);
  return parseSalesIntake(received[0]?.payload ?? null);
}

export async function queueRelationshipLifecycle(
  contractId: number,
  lifecycle: "activated" | "cancelled",
  actorUserId: number | null,
  closureReason?: string | null,
) {
  const db = await getDb();
  if (!db) return false;
  const intake = await linkedSalesIntakeForContract(contractId);
  if (!intake) return false;
  const [row] = await db.select({
    contract: contracts,
    customerName: customers.fullName,
    customerPhone: customers.phone,
    customerEmail: customers.email,
  }).from(contracts).innerJoin(customers, eq(contracts.customerId, customers.id))
    .where(eq(contracts.id, contractId)).limit(1);
  if (!row) return false;

  const externalEventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const eventName = lifecycle === "activated" ? "crm.contract.activated.v1" : "crm.contract.cancelled.v1";
  const body = {
    eventId: externalEventId,
    eventName,
    source: "crm",
    correlationId: intake.correlationId || randomUUID(),
    occurredAt,
    project: intake.project,
    saleId: intake.saleId,
    customerId: String(row.contract.customerId),
    contractId: String(row.contract.id),
    customer: {
      name: row.customerName,
      ...(row.customerPhone ? { phone: row.customerPhone } : {}),
      ...(row.customerEmail ? { email: row.customerEmail } : {}),
    },
    ...(lifecycle === "activated"
      ? { effectiveAt: row.contract.activatedAt?.toISOString() ?? occurredAt }
      : { closureReason: closureReason?.trim() || row.contract.cancellationReason || "Contrato cancelado no CRM" }),
  };

  await recordDomainEvent({
    eventName: "relationship.delivery.pending",
    aggregateType: "contract",
    aggregateId: contractId,
    actorUserId,
    payload: { externalEventId, body },
  });
  return true;
}

function bearer(request: Request) {
  const value = request.get("Authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export function registerSalesCommandIntegration(app: Express) {
  app.post("/api/integration/sales-events", async (request: Request, response: Response) => {
    const key = process.env.SALES_COMMAND_INTEGRATION_KEY?.trim();
    if (!key) {
      response.status(503).json({ error: "Integration unavailable" });
      return;
    }
    const supplied = bearer(request);
    if (!supplied || !safeEqual(supplied, key)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = salesEventSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid event" });
      return;
    }
    const db = await getDb();
    if (!db) {
      response.status(503).json({ error: "Database unavailable" });
      return;
    }
    const idempotencyKey = `sales-command:${parsed.data.eventId}`;
    try {
      const result = await db.transaction(async tx => {
        const [existing] = await tx.select({ payload: domainEvents.payload }).from(domainEvents)
          .where(eq(domainEvents.idempotencyKey, idempotencyKey)).limit(1);
        const replay = parseSalesIntake(existing?.payload ?? null);
        if (replay) return { replay: true, crmCustomerId: replay.crmCustomerId };

        let customerId: number | null = null;
        if (parsed.data.customer.phone) {
          const samePhone = await tx.select({ id: customers.id }).from(customers)
            .where(eq(customers.phone, parsed.data.customer.phone)).limit(2);
          if (samePhone.length > 1) throw new AmbiguousSalesIntakeError("Telefone corresponde a mais de um cliente no CRM.");
          customerId = samePhone[0]?.id ?? null;
        }
        if (!customerId) {
          const created = await tx.insert(customers).values({
            fullName: parsed.data.customer.name,
            phone: parsed.data.customer.phone ?? null,
            email: parsed.data.customer.email ?? null,
            acquisitionSource: "TGR Sales Command",
            status: "prospect",
          }).$returningId();
          customerId = created[0]?.id ?? null;
        }
        if (!customerId) throw new Error("CRM customer creation failed");

        const payload: SalesCommandIntake = {
          ...parsed.data,
          crmCustomerId: customerId,
          sourceEventId: parsed.data.eventId,
        };
        await tx.insert(domainEvents).values({
          eventName: "sales.intake.received",
          aggregateType: "external_sale",
          aggregateId: parsed.data.saleId,
          actorUserId: null,
          payload: JSON.stringify(payload),
          idempotencyKey,
        });
        await tx.insert(auditLogs).values({
          actorUserId: null,
          entityType: "sales_intake",
          entityId: parsed.data.saleId,
          action: "received",
          summary: "Venda confirmada recebida do TGR Sales Command.",
          idempotencyKey: `audit:${idempotencyKey}`,
        });
        return { replay: false, crmCustomerId: customerId };
      });
      response.status(result.replay ? 200 : 201).json({ accepted: true, ...result });
    } catch (error) {
      if (error instanceof AmbiguousSalesIntakeError) {
        response.status(409).json({ error: error.message });
        return;
      }
      response.status(503).json({ error: "Event processing failed" });
    }
  });
}

type FetchLike = typeof fetch;

function validateRelationshipEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Relationship endpoint must use HTTP(S)");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Relationship endpoint requires TLS outside loopback");
  }
  return new URL("/api/integration/events", url).toString();
}

export function createRelationshipDeliveryPump(
  options: {
    endpoint: string;
    integrationKey: string;
    fetchImpl?: FetchLike;
    intervalMs?: number;
    autoStart?: boolean;
    onError?: (error: unknown) => void;
  },
) {
  const target = validateRelationshipEndpoint(options.endpoint);
  if (!options.integrationKey.trim()) throw new Error("Relationship CRM integration key required");
  const fetchImpl = options.fetchImpl ?? fetch;
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return 0;
    running = true;
    let delivered = 0;
    try {
      const db = await getDb();
      if (!db) return 0;
      const pending = await db.select({ id: domainEvents.id, payload: domainEvents.payload }).from(domainEvents)
        .where(eq(domainEvents.eventName, "relationship.delivery.pending"))
        .orderBy(domainEvents.id).limit(100);
      for (const item of pending) {
        const payload = parsePayload(item.payload);
        const externalEventId = typeof payload?.externalEventId === "string" ? payload.externalEventId : null;
        const body = payload?.body && typeof payload.body === "object" && !Array.isArray(payload.body)
          ? payload.body as Record<string, unknown>
          : null;
        if (!externalEventId || !body) continue;
        const marker = `relationship-delivered:${externalEventId}`;
        const [already] = await db.select({ id: auditLogs.id }).from(auditLogs)
          .where(eq(auditLogs.idempotencyKey, marker)).limit(1);
        if (already) continue;
        try {
          const response = await fetchWithTimeout(target, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + options.integrationKey,
              "X-Correlation-Id": typeof body.correlationId === "string" ? body.correlationId : externalEventId,
            },
            body: JSON.stringify(body),
          }, 8_000);
          if (!response.ok) throw new Error("Relationship delivery failed with HTTP " + response.status);
          await recordAudit(null, "relationship_delivery", externalEventId, "delivered", "Evento CRM entregue ao TGR Relationship.", { idempotencyKey: marker });
          delivered += 1;
        } catch (error) {
          options.onError?.(error);
        }
      }
      return delivered;
    } finally {
      running = false;
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.autoStart !== false) {
    timer = setInterval(() => { void tick(); }, options.intervalMs ?? 5_000);
    timer.unref?.();
    void tick();
  }
  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
