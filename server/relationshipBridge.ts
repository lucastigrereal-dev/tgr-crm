import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { auditLogs, contracts, customers, domainEvents, proposals } from "../drizzle/schema";
import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";

// "validated" não é status de contrato: vem do evento sale.validated (ADR-007) e só o Sales Command o recebe.
type BridgeStatus = "active" | "cancelled" | "validated";

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
  /** Recibos/ações próprios da entrega crm.sale.validated.v1 (só o alvo que recebe "validated" os define). */
  validatedActions?: { delivered: string; notApplicable: string; rejected: string };
}

// Recusa de CONTEÚDO (400/409/422) repetida MAX_CONTENT_REJECTIONS vezes seguidas vira recibo terminal e a fila segue.
// 401/403/404 (chave/endpoint errados), 5xx e rede nunca descartam: tentam de novo e alertam.
// ponytail: contador em memória (zera no restart, então um veneno leva no máximo +5 tentativas por boot).
// Reprocessar um recusado: apagar a linha de audit_logs com o idempotencyKey do recibo (ver roteiro do piloto).
export const MAX_CONTENT_REJECTIONS = 5;
export const MIN_REJECTION_WINDOW_MS = 10 * 60_000; // e há pelo menos 10 min desde a 1ª (um 400 passageiro não esvazia a fila)

/**
 * Contador de recusas de conteúdo seguidas por chave. Qualquer outra falha ou sucesso zera.
 * PIL-008 (R7): recusa TIPADA (4xx + code) desiste na 1ª. `conflictIsTransient`: 409 sem code é ordem de chegada
 * (Financial: comissão paga antes do sale.validated) e nunca desiste.
 */
export function createRejectionTracker<K>(windowMs: number, now: () => number = Date.now, options: { conflictIsTransient?: boolean } = {}) {
  const seen = new Map<K, { count: number; firstAt: number }>();
  return {
    /** true = desistir agora (gravar recibo terminal). */
    record(key: K, error: unknown) {
      if (error instanceof DeliveryRejectedError && error.code) { seen.delete(key); return true; }
      if (!(error instanceof DeliveryRejectedError) || !isContentRejection(error.status)
        || (options.conflictIsTransient && error.status === 409)) { seen.delete(key); return false; }
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
  constructor(readonly label: string, readonly status: number, readonly code?: string) {
    super(label + " delivery failed with HTTP " + status + (code ? " " + code : ""));
  }
  /** "HTTP 422 SALE_..." ou "HTTP 503": o motivo que vai para o recibo terminal (DLQ). */
  get reason() { return "HTTP " + this.status + (this.code ? " " + this.code : ""); }
}

const TRANSIENT_4XX = new Set([408, 425, 429]);
/** PIL-008 (R7): só 4xx de conteúdo (fora 408/425/429) com `code` [A-Z0-9_] é recusa tipada; o resto não tem code. */
export async function refusalFromResponse(label: string, response: Response) {
  let code: string | undefined;
  if (response.status >= 400 && response.status < 500 && !TRANSIENT_4XX.has(response.status)) {
    try {
      const body = await response.json() as { code?: unknown };
      if (typeof body?.code === "string" && /^[A-Z0-9_]{1,120}$/.test(body.code)) code = body.code;
    } catch { /* corpo não-JSON: sem code */ }
  }
  return new DeliveryRejectedError(label, response.status, code);
}

/** Texto do recibo terminal: recusa tipada cita o code; a tolerância de 5 recusas sem code mantém o texto antigo. */
export function rejectionSummary(eventName: string, label: string, error: unknown) {
  const rejected = error as DeliveryRejectedError;
  return rejected.code
    ? eventName + " recusado pelo TGR " + label + " (" + rejected.reason + ")."
    : eventName + " recusado pelo TGR " + label + " " + MAX_CONTENT_REJECTIONS + "x seguidas (HTTP " + rejected.status + ").";
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
  statuses: ["cancelled", "validated"],
  deliveredAction: "sales_cancellation_delivered",
  notApplicableAction: "sales_cancellation_not_applicable",
  rejectedAction: "sales_cancellation_rejected",
  includeCustomer: false, // o Sales não guarda dados pessoais do cliente; não enviar
  validatedActions: { delivered: "sales_sale_validated_delivered", notApplicable: "sales_sale_validated_not_applicable", rejected: "sales_sale_validated_rejected" },
};

function actionsFor(target: ContractStateTarget, state: BridgeStatus) {
  if (state === "validated" && target.validatedActions) return target.validatedActions;
  return { delivered: target.deliveredAction, notApplicable: target.notApplicableAction, rejected: target.rejectedAction };
}
function eventNameFor(state: BridgeStatus) {
  return state === "active" ? "crm.contract.activated.v1" : state === "validated" ? "crm.sale.validated.v1" : "crm.contract.cancelled.v1";
}

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

export type ContractLineage = NonNullable<Awaited<ReturnType<typeof lineageForContract>>>;

// WP5 (PRD v4 E0.3): corpo puro do evento de contrato. É a MESMA função usada na entrega e no export do contrato
// (shared/contracts/tgr-events.snapshot.json), então o snapshot dos consumidores não deriva do código real.
export function buildContractStateBody(lineage: ContractLineage, status: BridgeStatus, contractId: number, occurredAt: Date, includeCustomer: boolean) {
  const eventName = status === "active" ? "crm.contract.activated.v1" : "crm.contract.cancelled.v1";
  const correlationId = lineage.correlationId ?? ("crm-rel-" + contractId + "-" + status);
  return {
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
    ...(includeCustomer ? {
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
}

export type SaleValidatedFacts = {
  validatedAt: string; validatedBy: string;
  paymentConfirmedAt: string; paymentConfirmedBy: string;
  contractGeneratedAt: string; contractSignedAt: string; documentStoredAt: string; documentRef: string;
};

// KAN-31 V6: fato "venda validada" para o Sales Command, no formato exato que o intake do Sales aceita
// (crm-sale-validation-intake.ts). SEM dados pessoais do cliente; documentRef é a chave opaca crm-doc:<contrato>:<doc>.
export function buildSaleValidatedBody(lineage: ContractLineage, contractId: number, occurredAt: Date, facts: SaleValidatedFacts) {
  const correlationId = lineage.correlationId ?? ("crm-sale-" + contractId + "-validated");
  return {
    eventId: "crm-sale-" + contractId + "-validated",
    eventName: "crm.sale.validated.v1" as const,
    source: "crm",
    correlationId,
    occurredAt: occurredAt.toISOString(),
    project: {
      externalKey: lineage.projectExternalKey,
      name: lineage.projectName,
      timezone: lineage.projectTimezone,
    },
    saleId: lineage.saleId,
    contractId: String(contractId),
    validatedAt: facts.validatedAt,
    validatedBy: facts.validatedBy,
    gates: {
      paymentConfirmedAt: facts.paymentConfirmedAt,
      paymentConfirmedBy: facts.paymentConfirmedBy,
      contractGeneratedAt: facts.contractGeneratedAt,
      contractSignedAt: facts.contractSignedAt,
      documentStoredAt: facts.documentStoredAt,
      documentRef: facts.documentRef,
    },
  };
}

const OPAQUE_ACTOR_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const OPAQUE_DOCUMENT_REF = /^crm-doc:\d{1,10}:\d{1,10}$/;

/**
 * Lê os fatos do payload de sale.validated; null se algum faltar, for inválido ou se um portão for posterior à
 * validação. Mesmas regras do receptor do Sales: o CRM não envia o que o Sales recusaria (iria direto para a DLQ).
 */
export function saleValidatedFactsFrom(payload: Record<string, unknown>): SaleValidatedFacts | null {
  const instant = (key: string) => { const value = requiredText(payload, key); return value && !Number.isNaN(Date.parse(value)) ? value : null; };
  const actor = (key: string) => { const value = requiredText(payload, key); return value && OPAQUE_ACTOR_ID.test(value) ? value : null; };
  const documentRef = requiredText(payload, "documentRef");
  const facts = {
    validatedAt: instant("validatedAt"), validatedBy: actor("validatedBy"),
    paymentConfirmedAt: instant("paymentConfirmedAt"), paymentConfirmedBy: actor("paymentConfirmedBy"),
    contractGeneratedAt: instant("contractGeneratedAt"), contractSignedAt: instant("contractSignedAt"), documentStoredAt: instant("documentStoredAt"),
    documentRef: documentRef && OPAQUE_DOCUMENT_REF.test(documentRef) ? documentRef : null,
  };
  if (Object.values(facts).some(value => value === null)) return null;
  const complete = facts as SaleValidatedFacts;
  const validated = Date.parse(complete.validatedAt);
  if ([complete.paymentConfirmedAt, complete.contractGeneratedAt, complete.contractSignedAt, complete.documentStoredAt].some(value => Date.parse(value) > validated)) return null;
  return complete;
}

export const CONTRACT_STATE_TARGETS = { relationship: RELATIONSHIP_TARGET, salesCancellation: SALES_CANCELLATION_TARGET } as const;

async function alreadyHandled(idempotencyKey: string) {
  const db = await getDb();
  if (!db) return false;
  const [row] = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.idempotencyKey, idempotencyKey)).limit(1);
  return Boolean(row);
}

async function deliverContractState(target: ContractStateTarget, endpoint: string, key: string, contractId: number, status: BridgeStatus, occurredAt: Date, eventPayload: Record<string, unknown> = {}) {
  const receiptKey = target.receiptPrefix + contractId + ":" + status;
  const actions = actionsFor(target, status);
  if (await alreadyHandled(receiptKey)) return "already";
  const lineage = await lineageForContract(contractId);
  if (!lineage) {
    await recordAudit(null, "contract", contractId, actions.notApplicable, "Contrato sem linhagem Sales Command; bridge " + target.label + " não aplicável.", { idempotencyKey: receiptKey });
    return "not_applicable";
  }
  let body: ReturnType<typeof buildContractStateBody> | ReturnType<typeof buildSaleValidatedBody>;
  if (status === "validated") {
    const facts = saleValidatedFactsFrom(eventPayload);
    if (!facts) {
      // Red Team P2: fato inválido é recusa visível (DLQ), não "não aplicável"; o payload é imutável, retry não ajudaria.
      await recordAudit(null, "contract", contractId, actions.rejected, "sale.validated sem os portões válidos (instantes, atores opacos, documentRef opaco); não enviado ao TGR " + target.label + ".", { idempotencyKey: receiptKey });
      return "rejected";
    }
    body = buildSaleValidatedBody(lineage, contractId, occurredAt, facts);
  } else {
    body = buildContractStateBody(lineage, status, contractId, occurredAt, target.includeCustomer);
  }
  const { eventName, correlationId } = body;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
      "X-Correlation-Id": correlationId,
    },
    body: JSON.stringify(body),
  }, 8_000);
  if (!response.ok) throw await refusalFromResponse(target.label, response);
  await recordAudit(null, "contract", contractId, actions.delivered, eventName + " entregue ao TGR " + target.label + ".", { idempotencyKey: receiptKey });
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
          inArray(domainEvents.eventName, ["contract.created", "contract.status.updated", "sale.validated"]),
          gt(domainEvents.id, cursor),
        ))
        .orderBy(asc(domainEvents.id)).limit(500);
      let advanceTo = cursor;
      let blocked = false;
      for (const event of events) {
        const payload = objectPayload(event.payload);
        const state = event.eventName === "sale.validated" ? "validated" : payload.status;
        const contractId = Number(event.aggregateId);
        if ((state === "active" || state === "cancelled" || state === "validated") && target.statuses.includes(state)
          && Number.isInteger(contractId) && contractId > 0) {
          const receiptKey = target.receiptPrefix + contractId + ":" + state;
          try {
            const result = await deliverContractState(target, url, integrationKey, contractId, state, event.occurredAt, payload);
            if (result === "delivered") delivered += 1;
            rejections.clear(receiptKey);
          } catch (error) {
            options.onError?.(error);
            if (rejections.record(receiptKey, error)) {
              await recordAudit(null, "contract", contractId, actionsFor(target, state).rejected,
                rejectionSummary(eventNameFor(state), target.label, error), { idempotencyKey: receiptKey });
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
