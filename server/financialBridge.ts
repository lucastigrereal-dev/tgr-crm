import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { auditLogs, contracts, domainEvents } from "../drizzle/schema";
import { isKnownDomainEvent, type DomainEventName } from "../shared/domainEvents";
import { toIntegrationEvent } from "../shared/integrationContract";
import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";
import { createRejectionTracker, createRetryBackoff, drainOrdered, DeliveryRejectedError, MIN_REJECTION_WINDOW_MS, readRejectionCode, rejectionReceiptSummary } from "./relationshipBridge";

export const FINANCIAL_EVENT_NAMES = [
  "contract.created",
  "contract.created.v2",
  "contract.status.updated",
  "contract.cancellation.executed",
  // KAN-31 V6: só `sale.validated` vai ao Financial (enum do receptor). `sale.payment.confirmed` é fato interno do CRM:
  // o Financial recusaria com 400 e o evento acabaria em recibo terminal.
  "sale.validated",
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
  const integrationEvent = toIntegrationEvent({ ...event, eventName: event.eventName });
  // KAN-31 V6: o Financial valida sale.validated com z.strictObject {contractId: texto, saleId, validatedAt, validatedBy}.
  if (event.eventName === "sale.validated" && integrationEvent.payload.contractId != null) {
    integrationEvent.payload.contractId = String(integrationEvent.payload.contractId);
  }
  return {
    source: "crm" as const,
    correlationId: "crm-fin-" + event.id,
    project,
    event: integrationEvent,
  };
}

async function alreadyHandled(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, eventId: number) {
  const key = "financial-event:" + eventId;
  const [receipt] = await db.select({ id: auditLogs.id }).from(auditLogs)
    .where(eq(auditLogs.idempotencyKey, key)).limit(1);
  return Boolean(receipt);
}

/** Chave de ordem do Financial: contrato (payload.contractId, ou o agregado quando ele é o contrato); senão o agregado. */
export function financialOrderKey(event: { aggregateType: string; aggregateId: string; payload: string | null }) {
  try {
    const parsed = event.payload ? JSON.parse(event.payload) as Record<string, unknown> : {};
    const raw = parsed?.contractId;
    if (typeof raw === "number" && Number.isInteger(raw)) return "contract:" + raw;
    if (typeof raw === "string" && /^\d+$/.test(raw)) return "contract:" + Number(raw);
  } catch { /* payload ilegível: cai no agregado */ }
  return event.aggregateType === "contract" ? "contract:" + Number(event.aggregateId) : event.aggregateType + ":" + event.aggregateId;
}

export interface FinancialBridgePump { tick(): Promise<number>; stop(): void; }

type DomainEventRow = typeof domainEvents.$inferSelect;

export function startFinancialBridgePump(
  endpoint: string,
  integrationKey: string,
  project: FinancialBridgeProject,
  options: { intervalMs?: number; autoStart?: boolean; onError?: (error: unknown) => void; rejectionWindowMs?: number; now?: () => number; batchSize?: number } = {},
): FinancialBridgePump {
  const target = financialBridgeTarget(endpoint);
  if (!integrationKey.trim()) throw new Error("Financial CRM integration key required");
  if (!project.externalKey.trim() || !project.name.trim() || !project.timezone.trim()) {
    throw new Error("Financial project identity required");
  }
  const intervalMs = options.intervalMs ?? 5_000;
  const now = options.now ?? Date.now;
  const batchSize = options.batchSize ?? 500;
  let running = false;
  let stopped = false;
  // Cursor por id (em memória) + backoff por evento: evento com falha não-terminal (5xx sem code, rede, chave errada) é retentado
  // com 5s dobrando (teto 10 min) e NÃO fica na frente do lote; sem isso os mesmos 500 presos eram relidos/martelados a cada tick
  // e escondiam os eventos novos. ponytail: zera no restart (os sem recibo são relidos; a entrega é idempotente pelo recibo).
  let cursor = 0;
  const retry = createRetryBackoff<number, DomainEventRow>(now);
  // 409 sem code no Financial = ordem de chegada (ex.: comissão paga antes do sale.validated): tenta sempre, nunca DLQ.
  const rejections = createRejectionTracker<number>(options.rejectionWindowMs ?? MIN_REJECTION_WINDOW_MS, Date.now, { codedRejections: true, conflictIsTransient: true });

  async function attempt(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, event: DomainEventRow): Promise<boolean> {
    try {
      if (await alreadyHandled(db, event.id)) { retry.remove(event.id); return false; }
      const body = financialBridgeEnvelope(event, project);
      // KAN-30: sale.validated vai ao Financial mesmo sem saleId (contrato criado direto no CRM, sem linhagem Sales Command).
      // O Financial aceita saleId nulo e reconhece pelo contractId; segurar o evento deixava venda validada fora do oficial.
      // saleId nunca é inventado: vai null.
      const contractIdRaw = body.event.payload.contractId;
      const contractId = typeof contractIdRaw === "number"
        ? contractIdRaw
        : typeof contractIdRaw === "string" && /^\d+$/.test(contractIdRaw)
          ? Number(contractIdRaw)
          : null;
      // sale.validated tem payload estrito no Financial: nenhum enriquecimento (customerId lá seria 400).
      if (contractId && body.event.payload.customerId == null && event.eventName !== "sale.validated") {
        const [contract] = await db.select({ customerId: contracts.customerId }).from(contracts)
          .where(eq(contracts.id, contractId)).limit(1);
        if (contract?.customerId) body.event.payload.customerId = contract.customerId;
      }
      const response = await fetchWithTimeout(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + integrationKey,
          "X-Correlation-Id": body.correlationId,
        },
        body: JSON.stringify(body),
      }, 8_000);
      if (!response.ok) throw new DeliveryRejectedError("Financial", response.status, await readRejectionCode(response));
      await recordAudit(
        null,
        "integration_event",
        event.id,
        "financial_delivered",
        event.eventName + " entregue ao TGR Financial Layer.",
        { idempotencyKey: "financial-event:" + event.id },
      );
      rejections.clear(event.id);
      retry.remove(event.id);
      return true;
    } catch (error) {
      options.onError?.(error);
      // Mesma regra do bridge de contrato: só recusa de conteúdo repetida (e por tempo mínimo) vira recibo terminal.
      if (rejections.record(event.id, error)) {
        await recordAudit(null, "integration_event", event.id, "financial_rejected",
          rejectionReceiptSummary(event.eventName, "Financial Layer", error as DeliveryRejectedError),
          { idempotencyKey: "financial-event:" + event.id });
        retry.remove(event.id);
      } else {
        retry.fail(event.id, event);
      }
      return false;
    }
  }

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
          gt(domainEvents.id, cursor),
        ))
        .orderBy(asc(domainEvents.id)).limit(batchSize);
      delivered = await drainOrdered({
        retry, fresh: events.map(row => row.event), onError: options.onError,
        orderKey: financialOrderKey,
        attempt: event => attempt(db, event),
        advance: id => { cursor = Math.max(cursor, id); },
      });
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
