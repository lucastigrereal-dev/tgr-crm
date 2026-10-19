import { and, desc, inArray, like, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { auditLogs, domainEvents } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { getDb } from "./db";
import { FINANCIAL_EVENT_NAMES } from "./financialBridge";
import { CONTRACT_STATE_EVENT_NAMES, CONTRACT_STATE_TARGETS, contractStateUnhandled } from "./relationshipBridge";

/**
 * Painel de falhas das integrações (TSE #34). Lê só o que as pontes já gravam: o recibo (audit_logs, chave
 * `<prefixo><id>`) diz se o evento foi entregue, recusado de vez ou não se aplica; evento sem recibo está pendente e as
 * pontes o tentam de novo sozinhas, com espera crescente. Nada aqui escreve.
 */
export const INTEGRATION_WINDOW_DAYS = 30;
/** Pendente há mais que isso já passou da entrega normal (a ponte tenta a cada poucos segundos). */
export const INTEGRATION_STUCK_AFTER_MINUTES = 5;
const RECENT_REJECTED_LIMIT = 20;

type BridgeKey = "financial" | "relationship" | "salesCancellation";
type BridgeDef = { key: BridgeKey; label: string; receiptPrefix: string; eventNames: readonly string[]; unhandled: () => SQL; configured: () => boolean };

const BRIDGES: BridgeDef[] = [
  { key: "financial", label: "TGR Financial Layer", receiptPrefix: "financial-event:", eventNames: FINANCIAL_EVENT_NAMES, unhandled: () => sql`NOT EXISTS (SELECT 1 FROM ${auditLogs} WHERE ${auditLogs.idempotencyKey} = CONCAT('financial-event:', ${domainEvents.id}))`, configured: () => Boolean(ENV.financialEndpoint.trim() && ENV.financialCrmIntegrationKey.trim()) },
  { key: "relationship", label: "TGR Relationship", receiptPrefix: CONTRACT_STATE_TARGETS.relationship.receiptPrefix, eventNames: CONTRACT_STATE_EVENT_NAMES, unhandled: () => contractStateUnhandled(CONTRACT_STATE_TARGETS.relationship), configured: () => Boolean(ENV.relationshipEndpoint.trim() && ENV.relationshipCrmIntegrationKey.trim()) },
  { key: "salesCancellation", label: "TGR Sales Command", receiptPrefix: CONTRACT_STATE_TARGETS.salesCancellation.receiptPrefix, eventNames: CONTRACT_STATE_EVENT_NAMES, unhandled: () => contractStateUnhandled(CONTRACT_STATE_TARGETS.salesCancellation), configured: () => Boolean(ENV.salesCommandEndpoint.trim() && ENV.salesCommandCancellationKey.trim()) },
];

/** Prefixos dos recibos de cada ponte e os eventos que ela lê: o "reenviar" do painel se apoia neles. */
export const BRIDGE_RECEIPTS = BRIDGES.map(bridge => ({ key: bridge.key, label: bridge.label, receiptPrefix: bridge.receiptPrefix, eventNames: bridge.eventNames }));

const resultOf = (action: string) => action.endsWith("_rejected") ? "rejected" : action.endsWith("_not_applicable") ? "notApplicable" : action.endsWith("_delivered") ? "delivered" : null;

export async function integrationHealth() {
  const db = await getDb();
  if (!db) return { windowDays: INTEGRATION_WINDOW_DAYS, stuckAfterMinutes: INTEGRATION_STUCK_AFTER_MINUTES, bridges: [], rejected: [] };
  const since = sql`NOW() - INTERVAL ${INTEGRATION_WINDOW_DAYS} DAY`;
  const stuckBefore = sql`NOW() - INTERVAL ${INTEGRATION_STUCK_AFTER_MINUTES} MINUTE`;

  const bridges = await Promise.all(BRIDGES.map(async bridge => {
    const receipts = await db.select({ action: auditLogs.action, total: sql<number>`count(*)` }).from(auditLogs).where(like(auditLogs.idempotencyKey, `${bridge.receiptPrefix}%`)).groupBy(auditLogs.action);
    const counts = { delivered: 0, rejected: 0, notApplicable: 0 };
    for (const row of receipts) { const kind = resultOf(row.action); if (kind) counts[kind] += Number(row.total); }
    const [pending] = await db.select({ total: sql<number>`count(*)`, stuck: sql<number>`coalesce(sum(${domainEvents.occurredAt} < ${stuckBefore}), 0)`, oldest: sql<Date | null>`min(${domainEvents.occurredAt})` }).from(domainEvents)
      .where(and(inArray(domainEvents.eventName, [...bridge.eventNames]), sql`${domainEvents.occurredAt} >= ${since}`, bridge.unhandled()));
    // Só diz se a ponte está ligada (endereço e chave presentes); nunca devolve o valor de nenhum dos dois.
    return { key: bridge.key, label: bridge.label, configured: bridge.configured(), ...counts, pending: Number(pending?.total ?? 0), stuck: Number(pending?.stuck ?? 0), oldestPendingAt: pending?.oldest ? new Date(pending.oldest) : null };
  }));

  const rejectedRows = (await Promise.all(BRIDGES.map(async bridge => {
    const rows = await db.select({ id: auditLogs.id, action: auditLogs.action, entityType: auditLogs.entityType, entityId: auditLogs.entityId, summary: auditLogs.summary, createdAt: auditLogs.createdAt }).from(auditLogs)
      .where(and(like(auditLogs.idempotencyKey, `${bridge.receiptPrefix}%`), like(auditLogs.action, "%\\_rejected"))).orderBy(desc(auditLogs.id)).limit(RECENT_REJECTED_LIMIT);
    return rows.map(row => ({ ...row, bridge: bridge.label }));
  }))).flat().sort((a, b) => b.id - a.id).slice(0, RECENT_REJECTED_LIMIT);

  return { windowDays: INTEGRATION_WINDOW_DAYS, stuckAfterMinutes: INTEGRATION_STUCK_AFTER_MINUTES, bridges, rejected: rejectedRows };
}
