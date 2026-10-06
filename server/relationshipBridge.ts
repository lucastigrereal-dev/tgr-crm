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
/**
 * Backoff exponencial por evento (em memória). Falha não-terminal (5xx/rede/chave errada/recusa sem código ainda não desistida):
 * o evento entra aqui, sai da frente da fila (o cursor segue) e só é retentado quando vence: 5s, 10s, 20s... teto 10 min.
 * Sem isso um evento preso era martelado a cada tick e, com o cursor parado nele, os 500 primeiros presos escondiam os novos.
 * ponytail: zera no restart (reler é seguro: a entrega é idempotente pelo recibo).
 */
export const RETRY_BASE_MS = 5_000;
export const RETRY_CAP_MS = 10 * 60_000;
export function createRetryBackoff<K, V>(now: () => number = Date.now) {
  const entries = new Map<K, { attempts: number; nextAt: number; item: V }>();
  return {
    fail(key: K, item: V) {
      const attempts = (entries.get(key)?.attempts ?? 0) + 1;
      entries.set(key, { attempts, nextAt: now() + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS), item });
    },
    /** Guarda o item sem contar tentativa (vence já): evento lido mas barrado por um mais antigo da mesma chave de ordem. */
    defer(key: K, item: V) { if (!entries.has(key)) entries.set(key, { attempts: 0, nextAt: now(), item }); },
    remove(key: K) { entries.delete(key); },
    scheduled(key: K) { return entries.has(key); },
    /** Todos os itens pendentes (qualquer backoff). */
    items(): V[] { return Array.from(entries.values()).map(entry => entry.item); },
    nextAt(key: K) { return entries.get(key)?.nextAt; },
    /** Itens cujo backoff venceu, do mais antigo para o mais novo. */
    due(): V[] {
      const t = now();
      return Array.from(entries.values()).filter(entry => entry.nextAt <= t).sort((a, b) => a.nextAt - b.nextAt).map(entry => entry.item);
    },
  };
}

/**
 * Ordem por chave (RED TEAM R1): um evento NÃO é tentado enquanto houver um evento MAIS ANTIGO, da mesma chave de ordem
 * (ex.: contrato), ainda pendente no backoff. Chaves sem relação seguem andando (sem inanição).
 * Nunca perde evento: o cursor só avança depois que o evento foi entregue/terminal OU registrado no backoff
 * (falha em qualquer etapa, inclusive leitura de recibo, entrega ou gravação do recibo, vai para o retry com backoff).
 */
export async function drainOrdered<E extends { id: number }>(opts: {
  retry: ReturnType<typeof createRetryBackoff<number, E>>;
  fresh: E[];
  orderKey: (event: E) => string;
  attempt: (event: E) => Promise<boolean>;
  advance: (id: number) => void;
  onError?: (error: unknown) => void;
}): Promise<number> {
  const { retry, orderKey } = opts;
  let delivered = 0;
  const blocked = (event: E) => { const key = orderKey(event); return retry.items().some(other => other.id < event.id && orderKey(other) === key); };
  const run = async (event: E) => {
    try { return await opts.attempt(event); } catch (error) {
      opts.onError?.(error);
      retry.fail(event.id, event); // falha inesperada: continua no conjunto de retry, com backoff
      return false;
    }
  };
  for (const event of retry.due().sort((a, b) => a.id - b.id)) {
    if (blocked(event)) continue;
    if (await run(event)) delivered += 1;
  }
  for (const event of opts.fresh) {
    if (!retry.scheduled(event.id)) {
      if (blocked(event)) retry.defer(event.id, event);
      else if (await run(event)) delivered += 1;
    }
    opts.advance(event.id);
  }
  return delivered;
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

type PumpOptions = { intervalMs?: number; autoStart?: boolean; onError?: (error: unknown) => void; rejectionWindowMs?: number; now?: () => number; batchSize?: number };
type DomainEventRow = typeof domainEvents.$inferSelect;

function startContractStatePump(
  target: ContractStateTarget,
  endpoint: string,
  integrationKey: string,
  options: PumpOptions,
): RelationshipBridgePump {
  const url = safeEndpoint(endpoint, target);
  if (!integrationKey.trim()) throw new Error(target.label + " CRM integration key required");
  const intervalMs = options.intervalMs ?? 5_000;
  const now = options.now ?? Date.now;
  const batchSize = options.batchSize ?? 500;
  let running = false;
  let stopped = false;
  // Cursor em memória: avança sobre TODO evento lido (inclusive os que falharam). Evento com falha não-terminal vai para o
  // backoff por evento (5s dobrando, teto 10 min) e é retentado só quando vence, sem ficar na frente da fila: antes o cursor
  // parava no 1º falho, ele era reenviado a cada tick e 500 presos escondiam todo evento novo.
  // ponytail: tudo zera no restart (reler é seguro, a entrega é idempotente pelo recibo).
  let cursor = 0;
  const retry = createRetryBackoff<number, DomainEventRow>(now);
  const rejections = createRejectionTracker<string>(options.rejectionWindowMs ?? MIN_REJECTION_WINDOW_MS, Date.now, { codedRejections: target.codedRejections });

  /** Tenta entregar um evento. Devolve true se entregou agora. Falha não-terminal agenda o retry. */
  async function attempt(event: DomainEventRow): Promise<boolean> {
    const payload = objectPayload(event.payload);
    const state = event.eventName === "sale.validated" ? "validated" : payload.status;
    const contractId = Number(event.aggregateId);
    if (!((state === "active" || state === "cancelled" || state === "validated") && target.statuses.includes(state)
      && Number.isInteger(contractId) && contractId > 0)) { retry.remove(event.id); return false; }
    const receiptKey = target.receiptPrefix + contractId + ":" + state;
    try {
      const result = await deliverContractState(target, url, integrationKey, contractId, state, event.occurredAt, payload);
      rejections.clear(receiptKey);
      retry.remove(event.id);
      return result === "delivered";
    } catch (error) {
      options.onError?.(error);
      if (rejections.record(receiptKey, error)) {
        await recordAudit(null, "contract", contractId, actionsFor(target, state).rejected,
          rejectionReceiptSummary(eventNameFor(state), target.label, error as DeliveryRejectedError),
          { idempotencyKey: receiptKey });
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
      const events = await db.select().from(domainEvents)
        .where(and(
          inArray(domainEvents.eventName, ["contract.created", "contract.status.updated", "sale.validated"]),
          gt(domainEvents.id, cursor),
        ))
        .orderBy(asc(domainEvents.id)).limit(batchSize);
      delivered = await drainOrdered({
        retry, fresh: events, onError: options.onError,
        orderKey: event => "contract:" + event.aggregateId,
        attempt,
        advance: id => { cursor = Math.max(cursor, id); },
      });
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
