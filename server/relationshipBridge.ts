import { asc, eq, inArray } from "drizzle-orm";
import { auditLogs, contracts, customers, domainEvents, opportunities, proposals } from "../drizzle/schema";
import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";

type BridgeStatus = "active" | "cancelled";

function safeEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Relationship endpoint must use HTTP(S)");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Relationship endpoint requires TLS outside loopback");
  }
  return new URL("/api/integration/events", url).toString();
}

function objectPayload(value: string | null) {
  if (!value) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function requiredText(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function lineageForContract(contractId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select({
    customerId: contracts.customerId,
    customerName: customers.fullName,
    customerPhone: customers.phone,
    proposalId: contracts.proposalId,
    opportunityId: proposals.opportunityId,
    cancellationReason: contracts.cancellationReason,
  }).from(contracts)
    .innerJoin(customers, eq(customers.id, contracts.customerId))
    .leftJoin(proposals, eq(proposals.id, contracts.proposalId))
    .where(eq(contracts.id, contractId)).limit(1);
  if (!row?.opportunityId) return null;
  const candidates = await db.select({ aggregateId: domainEvents.aggregateId, payload: domainEvents.payload }).from(domainEvents)
    .where(eq(domainEvents.eventName, "sales.command.sale.ingested")).orderBy(asc(domainEvents.id)).limit(500);
  const matched = candidates.find(item => item.aggregateId === String(row.opportunityId));
  if (!matched) return null;
  const lineage = objectPayload(matched.payload);
  const saleId = requiredText(lineage, "saleId");
  const projectExternalKey = requiredText(lineage, "projectExternalKey");
  const projectName = requiredText(lineage, "projectName");
  const projectTimezone = requiredText(lineage, "projectTimezone");
  if (!saleId || !projectExternalKey || !projectName || !projectTimezone) return null;
  return {
    saleId,
    projectExternalKey,
    projectName,
    projectTimezone,
    correlationId: requiredText(lineage, "correlationId"),
    customerId: row.customerId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    cancellationReason: row.cancellationReason,
  };
}

async function alreadyHandled(idempotencyKey: string) {
  const db = await getDb();
  if (!db) return false;
  const [row] = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.idempotencyKey, idempotencyKey)).limit(1);
  return Boolean(row);
}

async function deliverContractState(endpoint: string, key: string, contractId: number, status: BridgeStatus, occurredAt: Date) {
  const receiptKey = "relationship-contract:" + contractId + ":" + status;
  if (await alreadyHandled(receiptKey)) return "already";
  const lineage = await lineageForContract(contractId);
  if (!lineage) {
    await recordAudit(null, "contract", contractId, "relationship_not_applicable", "Contrato sem linhagem Sales Command; bridge Relationship não aplicável.", { idempotencyKey: receiptKey });
    return "not_applicable";
  }
  const eventName = status === "active" ? "crm.contract.activated.v1" : "crm.contract.cancelled.v1";
  const correlationId = lineage.correlationId ?? ("crm-rel-" + contractId + "-" + status);
  const body = {
    eventId: "crm-contract-" + contractId + "-" + status,
    eventName,
    source: "crm",
    correlationId,
    occurredAt: occurredAt.toISOString(),
    project: {
      externalKey: lineage.projectExternalKey,
      name: lineage.projectName,
      timezone: lineage.projectTimezone,
    },
    saleId: lineage.saleId,
    customerId: String(lineage.customerId),
    contractId: String(contractId),
    customer: {
      name: lineage.customerName,
      ...(lineage.customerPhone ? { phone: lineage.customerPhone } : {}),
    },
    ...(status === "cancelled" ? {
      effectiveAt: occurredAt.toISOString(),
      ...(lineage.cancellationReason ? { closureReason: lineage.cancellationReason } : {}),
    } : {}),
  };
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
      "X-Correlation-Id": correlationId,
    },
    body: JSON.stringify(body),
  }, 8_000);
  if (!response.ok) throw new Error("Relationship delivery failed with HTTP " + response.status);
  await recordAudit(null, "contract", contractId, "relationship_delivered", eventName + " entregue ao TGR Relationship.", { idempotencyKey: receiptKey });
  return "delivered";
}

export interface RelationshipBridgePump { tick(): Promise<number>; stop(): void; }

export function startRelationshipBridgePump(
  endpoint: string,
  integrationKey: string,
  options: { intervalMs?: number; autoStart?: boolean; onError?: (error: unknown) => void } = {},
): RelationshipBridgePump {
  const target = safeEndpoint(endpoint);
  if (!integrationKey.trim()) throw new Error("Relationship CRM integration key required");
  const intervalMs = options.intervalMs ?? 5_000;
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return 0;
    running = true;
    let delivered = 0;
    try {
      const db = await getDb();
      if (!db) return 0;
      const events = await db.select().from(domainEvents)
        .where(inArray(domainEvents.eventName, ["contract.created", "contract.status.updated"]))
        .orderBy(asc(domainEvents.id)).limit(500);
      for (const event of events) {
        const payload = objectPayload(event.payload);
        const state = payload.status;
        if (state !== "active" && state !== "cancelled") continue;
        const contractId = Number(event.aggregateId);
        if (!Number.isInteger(contractId) || contractId <= 0) continue;
        try {
          const result = await deliverContractState(target, integrationKey, contractId, state, event.occurredAt);
          if (result === "delivered") delivered += 1;
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
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    void tick();
  }
  return { tick, stop() { stopped = true; if (timer) clearInterval(timer); } };
}
