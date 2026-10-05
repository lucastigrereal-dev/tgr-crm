import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { auditLogs, contracts, customers, domainEvents, proposals } from "../drizzle/schema";
import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";

type BridgeStatus = "active" | "cancelled";

// Mesmo envelope crm.contract.*.v1 para dois consumidores: o Relationship recebe ativação e cancelamento;
// o Sales Command só o cancelamento (fato separado, não muda sales.status).
interface ContractStateTarget {
  label: string;
  path: string;
  receiptPrefix: string;
  statuses: readonly BridgeStatus[];
  deliveredAction: string;
  notApplicableAction: string;
  rejectedAction: string;
  includeCustomer: boolean;
}

// Recusa de CONTEÚDO (400/409/422) repetida MAX_CONTENT_REJECTIONS vezes seguidas vira recibo terminal e a fila segue.
// 401/403/404 (chave/endpoint errados), 5xx e rede nunca descartam: tentam de novo e alertam.
// ponytail: contador em memória (zera no restart, então um veneno leva no máximo +5 tentativas por boot).
// Reprocessar um recusado: apagar a linha de audit_logs com o idempotencyKey do recibo (ver roteiro do piloto).
export const MAX_CONTENT_REJECTIONS = 5;
export const MIN_REJECTION_WINDOW_MS = 10 * 60_000; // e há pelo menos 10 min desde a 1ª (um 400 passageiro não esvazia a fila)

/** Contador de recusas de conteúdo seguidas por chave. Qualquer outra falha ou sucesso zera. */
export function createRejectionTracker<K>(windowMs: number, now: () => number = Date.now) {
  const seen = new Map<K, { count: number; firstAt: number }>();
  return {
    /** true = desistir agora (gravar recibo terminal). */
    record(key: K, error: unknown) {
      if (!(error instanceof DeliveryRejectedError) || !isContentRejection(error.status)) { seen.delete(key); return false; }
      const entry = seen.get(key) ?? { count: 0, firstAt: now() };
      entry.count += 1;
      if (entry.count >= MAX_CONTENT_REJECTIONS && now() - entry.firstAt >= windowMs) { seen.delete(key); return true; }
      seen.set(key, entry);
      return false;
    },
    clear(key: K) { seen.delete(key); },
  };
}
export function isContentRejection(status: number) {
  return status === 400 || status === 409 || status === 422;
}

export class DeliveryRejectedError extends Error {
  constructor(readonly label: string, readonly status: number) {
    super(label + " delivery failed with HTTP " + status);
  }
}

const RELATIONSHIP_TARGET: ContractStateTarget = {
  label: "Relationship",
  path: "/api/integration/events",
  receiptPrefix: "relationship-contract:",
  statuses: ["active", "cancelled"],
  deliveredAction: "relationship_delivered",
  notApplicableAction: "relationship_not_applicable",
  rejectedAction: "relationship_rejected",
  includeCustomer: true,
};

const SALES_CANCELLATION_TARGET: ContractStateTarget = {
  label: "Sales Command",
  path: "/api/integration/crm/events",
  receiptPrefix: "sales-contract:",
  statuses: ["cancelled"],
  deliveredAction: "sales_cancellation_delivered",
  notApplicableAction: "sales_cancellation_not_applicable",
  rejectedAction: "sales_cancellation_rejected",
  includeCustomer: false, // o Sales não guarda dados pessoais do cliente; não enviar
};

function safeEndpoint(endpoint: string, target: ContractStateTarget) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(target.label + " endpoint must use HTTP(S)");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error(target.label + " endpoint requires TLS outside loopback");
  }
  return new URL(target.path, url).toString();
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
  const [matched] = await db.select({ payload: domainEvents.payload }).from(domainEvents)
    .where(and(
      eq(domainEvents.eventName, "sales.command.sale.ingested"),
      or(
        and(eq(domainEvents.aggregateType, "contract"), eq(domainEvents.aggregateId, String(contractId))),
        and(eq(domainEvents.aggregateType, "opportunity"), eq(domainEvents.aggregateId, String(row.opportunityId))),
      ),
    )).orderBy(asc(domainEvents.id)).limit(1);
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

async function deliverContractState(target: ContractStateTarget, endpoint: string, key: string, contractId: number, status: BridgeStatus, occurredAt: Date) {
  const receiptKey = target.receiptPrefix + contractId + ":" + status;
  if (await alreadyHandled(receiptKey)) return "already";
  const lineage = await lineageForContract(contractId);
  if (!lineage) {
    await recordAudit(null, "contract", contractId, target.notApplicableAction, "Contrato sem linhagem Sales Command; bridge " + target.label + " não aplicável.", { idempotencyKey: receiptKey });
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
    ...(target.includeCustomer ? {
      customer: {
        name: lineage.customerName,
        ...(lineage.customerPhone ? { phone: lineage.customerPhone } : {}),
      },
    } : {}),
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
  if (!response.ok) throw new DeliveryRejectedError(target.label, response.status);
  await recordAudit(null, "contract", contractId, target.deliveredAction, eventName + " entregue ao TGR " + target.label + ".", { idempotencyKey: receiptKey });
  return "delivered";
}

export interface RelationshipBridgePump { tick(): Promise<number>; stop(): void; }
export type SalesCancellationBridgePump = RelationshipBridgePump;

type PumpOptions = { intervalMs?: number; autoStart?: boolean; onError?: (error: unknown) => void; rejectionWindowMs?: number };

function startContractStatePump(
  target: ContractStateTarget,
  endpoint: string,
  integrationKey: string,
  options: PumpOptions,
): RelationshipBridgePump {
  const url = safeEndpoint(endpoint, target);
  if (!integrationKey.trim()) throw new Error(target.label + " CRM integration key required");
  const intervalMs = options.intervalMs ?? 5_000;
  let running = false;
  let stopped = false;
  // Cursor em memória: sem ele o pump relia sempre os mesmos 500 primeiros eventos e parava de entregar.
  // ponytail: zera no restart (reler é seguro, a entrega é idempotente pelo recibo); para no 1º evento com
  // falha para tentar de novo. Teto: 500 eventos seguidos falhando sempre ainda travam a fila.
  let cursor = 0;
  const rejections = createRejectionTracker<string>(options.rejectionWindowMs ?? MIN_REJECTION_WINDOW_MS);

  async function tick() {
    if (running || stopped) return 0;
    running = true;
    let delivered = 0;
    try {
      const db = await getDb();
      if (!db) return 0;
      const events = await db.select().from(domainEvents)
        .where(and(
          inArray(domainEvents.eventName, ["contract.created", "contract.status.updated"]),
          gt(domainEvents.id, cursor),
        ))
        .orderBy(asc(domainEvents.id)).limit(500);
      let advanceTo = cursor;
      let blocked = false;
      for (const event of events) {
        const payload = objectPayload(event.payload);
        const state = payload.status;
        const contractId = Number(event.aggregateId);
        if ((state === "active" || state === "cancelled") && target.statuses.includes(state)
          && Number.isInteger(contractId) && contractId > 0) {
          const receiptKey = target.receiptPrefix + contractId + ":" + state;
          try {
            const result = await deliverContractState(target, url, integrationKey, contractId, state, event.occurredAt);
            if (result === "delivered") delivered += 1;
            rejections.clear(receiptKey);
          } catch (error) {
            options.onError?.(error);
            if (rejections.record(receiptKey, error)) {
              const eventName = state === "active" ? "crm.contract.activated.v1" : "crm.contract.cancelled.v1";
              await recordAudit(null, "contract", contractId, target.rejectedAction,
                eventName + " recusado pelo TGR " + target.label + " " + MAX_CONTENT_REJECTIONS + "x seguidas (HTTP " + (error as DeliveryRejectedError).status + ").",
                { idempotencyKey: receiptKey });
            } else {
              blocked = true;
            }
          }
        }
        if (!blocked) advanceTo = event.id;
      }
      cursor = advanceTo;
      return delivered;
    } catch (error) {
      // Falha fora da entrega (ex.: banco indisponível) não pode virar unhandled rejection no timer e derrubar o CRM.
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

export function startRelationshipBridgePump(endpoint: string, integrationKey: string, options: PumpOptions = {}): RelationshipBridgePump {
  return startContractStatePump(RELATIONSHIP_TARGET, endpoint, integrationKey, options);
}

export function startSalesCancellationBridgePump(endpoint: string, integrationKey: string, options: PumpOptions = {}): SalesCancellationBridgePump {
  return startContractStatePump(SALES_CANCELLATION_TARGET, endpoint, integrationKey, options);
}
