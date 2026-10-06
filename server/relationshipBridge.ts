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
  /** Fala o contrato de recusa PIL-008 (4xx + `code`): terminal na 1ª vez. O Relationship mantém a regra repetida. */
  codedRejections?: boolean;
}

// Recusa de CONTEÚDO sem `code` (400/409/422) repetida MAX_CONTENT_REJECTIONS vezes seguidas vira recibo terminal e a fila segue;
// com `code` (^[A-Z0-9_]+$, 4xx exceto 408/425/429) é terminal na 1ª vez nos alvos Sales Command e Financial (PIL-008).
// 401/403/404 (chave/endpoint errados), 5xx e rede nunca descartam: tentam de novo e alertam.
// ponytail: contador em memória (zera no restart, então um veneno leva no máximo +5 tentativas por boot).
// Reprocessar um recusado: apagar a linha de audit_logs com o idempotencyKey do recibo (ver roteiro do piloto).
export const MAX_CONTENT_REJECTIONS = 5;
export const MIN_REJECTION_WINDOW_MS = 10 * 60_000; // e há pelo menos 10 min desde a 1ª (um 400 passageiro não esvazia a fila)

/** Contador de recusas de conteúdo seguidas por chave. Qualquer outra falha ou sucesso zera. */
export function createRejectionTracker<K>(windowMs: number, now: () => number = Date.now, options: { codedRejections?: boolean } = {}) {
  const seen = new Map<K, { count: number; firstAt: number }>();
  return {
    /** true = desistir agora (gravar recibo terminal). */
    record(key: K, error: unknown) {
      // PIL-008/R7: recusa de CONTEÚDO com `code` explícito (4xx exceto 408/425/429) é terminal já na 1ª vez e não segura a fila.
      // Só os alvos que falam esse contrato (Sales Command e Financial) ligam `codedRejections`; o Relationship segue a regra repetida.
      if (options.codedRejections && error instanceof DeliveryRejectedError && isCodedContentRejection(error.status, error.code)) { seen.delete(key); return true; }
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

const REJECTION_CODE = /^[A-Z0-9_]+$/;
/** 4xx exceto 408/425/429 (esses são "tente depois") com `code` presente. 5xx nunca. */
export function isCodedContentRejection(status: number, code: string | null | undefined) {
  return Boolean(code) && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}
/** Lê `code` do corpo JSON de uma recusa 4xx. Sem corpo/JSON/code válido (`^[A-Z0-9_]+$`) => null (recusa sem código). */
export async function readRejectionCode(response: Response): Promise<string | null> {
  if (response.status < 400 || response.status >= 500 || typeof response.json !== "function") return null;
  try {
    const body = await response.json() as unknown;
    const code = body && typeof body === "object" ? (body as Record<string, unknown>).code : undefined;
    return typeof code === "string" && REJECTION_CODE.test(code) ? code : null;
  } catch { return null; }
}
/** Texto do recibo terminal: com código => motivo explícito; sem código => regra repetida (texto histórico). */
export function rejectionReceiptSummary(eventName: string, targetLabel: string, error: DeliveryRejectedError) {
  return error.code
    ? eventName + " recusado pelo TGR " + targetLabel + " (HTTP " + error.status + ", code " + error.code.slice(0, 64) + ")."
    : eventName + " recusado pelo TGR " + targetLabel + " " + MAX_CONTENT_REJECTIONS + "x seguidas (HTTP " + error.status + ").";
}

export class DeliveryRejectedError extends Error {
  constructor(readonly label: string, readonly status: number, readonly code: string | null = null) {
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
  statuses: ["cancelled", "validated"],
  deliveredAction: "sales_cancellation_delivered",
  notApplicableAction: "sales_cancellation_not_applicable",
  rejectedAction: "sales_cancellation_rejected",
  includeCustomer: false, // o Sales não guarda dados pessoais do cliente; não enviar
  codedRejections: true,
  validatedActions: { delivered: "sales_sale_validated_delivered", notApplicable: "sales_sale_validated_not_applicable", rejected: "sales_sale_validated_rejected" },
};

function actionsFor(target: ContractStateTarget, state: BridgeStatus) {
  if (state === "validated" && target.validatedActions) return target.validatedActions;
  return { delivered: target.deliveredAction, notApplicable: target.notApplicableAction, rejected: target.rejectedAction };
}
function eventNameFor(state: BridgeStatus): string {
  switch (state) {
    case "active": return "crm.contract.activated.v1";
    case "cancelled": return "crm.contract.cancelled.v1";
    case "validated": return "crm.sale.validated.v1";
    default: { const unknown: never = state; throw new Error("Unknown bridge status: " + String(unknown)); }
  }
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
  // Exaustivo de propósito: "validated" tem builder próprio (buildSaleValidatedBody) e NUNCA pode sair como cancelado.
  let eventName: "crm.contract.activated.v1" | "crm.contract.cancelled.v1";
  switch (status) {
    case "active": eventName = "crm.contract.activated.v1"; break;
    case "cancelled": eventName = "crm.contract.cancelled.v1"; break;
    case "validated": throw new Error("buildContractStateBody não emite 'validated': use buildSaleValidatedBody (crm.sale.validated.v1).");
    default: { const unknown: never = status; throw new Error("Unknown bridge status: " + String(unknown)); }
  }
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

export type SaleValidatedFacts = { validatedAt: string; paymentConfirmedAt: string; signedAt: string };

// ADR-007 (V6): fato "venda validada" para o Sales Command. SEM dados pessoais do cliente e sem referência de documento.
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
    paymentConfirmedAt: facts.paymentConfirmedAt,
    signedAt: facts.signedAt,
  };
}

/** Lê os três instantes do payload de sale.validated; null se algum faltar/for inválido. */
export function saleValidatedFactsFrom(payload: Record<string, unknown>): SaleValidatedFacts | null {
  const read = (key: string) => { const value = requiredText(payload, key); return value && !Number.isNaN(Date.parse(value)) ? value : null; };
  const validatedAt = read("validatedAt"); const paymentConfirmedAt = read("paymentConfirmedAt"); const signedAt = read("signedAt");
  return validatedAt && paymentConfirmedAt && signedAt ? { validatedAt, paymentConfirmedAt, signedAt } : null;
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
      await recordAudit(null, "contract", contractId, actions.notApplicable, "sale.validated sem validatedAt/paymentConfirmedAt/signedAt válidos; entrega ao " + target.label + " não aplicável.", { idempotencyKey: receiptKey });
      return "not_applicable";
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
  if (!response.ok) throw new DeliveryRejectedError(target.label, response.status, target.codedRejections ? await readRejectionCode(response) : null);
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
  const rejections = createRejectionTracker<string>(options.rejectionWindowMs ?? MIN_REJECTION_WINDOW_MS, Date.now, { codedRejections: target.codedRejections });

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
                rejectionReceiptSummary(eventNameFor(state), target.label, error as DeliveryRejectedError),
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
