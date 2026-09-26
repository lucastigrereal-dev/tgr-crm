import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditLogs, domainEvents } from "../drizzle/schema";
import { isKnownDomainEvent, type DomainEventName } from "../shared/domainEvents";
import { toIntegrationEvent } from "../shared/integrationContract";
import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";

const FINANCIAL_EVENT_NAMES = [
  "contract.created",
  "contract.status.updated",
  "contract.cancellation.executed",
  "installment.paid",
  "commission.created",
  "commission.status.updated",
  "financial.entry.created",
  "financial.entry.reconciled",
  "financial.transfer.created",
  "financial.transfer.paid",
] as const satisfies readonly DomainEventName[];

export interface FinancialBridgeProject {
  externalKey: string;
  name: string;
  timezone: string;
}

export function financialBridgeTarget(endpoint: string) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Financial endpoint must use HTTP(S)");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Financial endpoint requires TLS outside loopback");
  }
  return new URL("/api/integration/crm-events", url).toString();
}

export function financialBridgeEnvelope(event: {
  id: number;
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  actorUserId: number | null;
  payload: string | null;
  occurredAt: Date;
}, project: FinancialBridgeProject) {
  if (!isKnownDomainEvent(event.eventName)) throw new Error("Unknown CRM domain event");
  return {
    source: "crm" as const,
    correlationId: "crm-fin-" + event.id,
    project,
    event: toIntegrationEvent({ ...event, eventName: event.eventName }),
  };
}

async function alreadyHandled(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, eventId: number) {
  const key = "financial-event:" + eventId;
  const [receipt] = await db.select({ id: auditLogs.id }).from(auditLogs)
    .where(eq(auditLogs.idempotencyKey, key)).limit(1);
  return Boolean(receipt);
}

export interface FinancialBridgePump { tick(): Promise<number>; stop(): void; }

export function startFinancialBridgePump(
  endpoint: string,
  integrationKey: string,
  project: FinancialBridgeProject,
  options: { intervalMs?: number; autoStart?: boolean; onError?: (error: unknown) => void } = {},
): FinancialBridgePump {
  const target = financialBridgeTarget(endpoint);
  if (!integrationKey.trim()) throw new Error("Financial CRM integration key required");
  if (!project.externalKey.trim() || !project.name.trim() || !project.timezone.trim()) {
    throw new Error("Financial project identity required");
  }
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
      const events = await db.select({ event: domainEvents }).from(domainEvents)
        .leftJoin(
          auditLogs,
          sql`${auditLogs.idempotencyKey} = CONCAT('financial-event:', ${domainEvents.id})`,
        )
        .where(and(
          inArray(domainEvents.eventName, [...FINANCIAL_EVENT_NAMES]),
          isNull(auditLogs.id),
        ))
        .orderBy(asc(domainEvents.id)).limit(500);
      for (const row of events) {
        const event = row.event;
        if (await alreadyHandled(db, event.id)) continue;
        try {
          const body = financialBridgeEnvelope(event, project);
          const response = await fetchWithTimeout(target, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + integrationKey,
              "X-Correlation-Id": body.correlationId,
            },
            body: JSON.stringify(body),
          }, 8_000);
          if (!response.ok) throw new Error("Financial delivery failed with HTTP " + response.status);
          await recordAudit(
            null,
            "integration_event",
            event.id,
            "financial_delivered",
            event.eventName + " entregue ao TGR Financial Layer.",
            { idempotencyKey: "financial-event:" + event.id },
          );
          delivered += 1;
        } catch (error) {
          options.onError?.(error);
        }
      }
      return delivered;
    } catch (error) {
      options.onError?.(error);
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
