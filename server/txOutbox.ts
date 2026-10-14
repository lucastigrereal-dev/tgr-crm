// Outbox transacional: `domain_events` é a fila que as pontes (Financial, Relationship) drenam por cursor.
// Gravar o evento com o MESMO `tx` do fato garante que fato e evento nascem juntos ou morrem juntos (issue #43).
import { sql } from "drizzle-orm";
import { auditLogs, domainEvents } from "../drizzle/schema";
import type { DomainEventName } from "../shared/domainEvents";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type AuditRow = typeof auditLogs.$inferInsert;
export type TxEventRow = { eventName: DomainEventName; aggregateType: string; aggregateId: number | string; actorUserId: number | null; payload: Record<string, unknown>; idempotencyKey?: string };

/** Auditoria dentro da transação; com `idempotencyKey`, repetir é no-op. */
export async function txAudit(tx: Tx, row: Omit<AuditRow, "entityId"> & { entityId: number | string }) {
  const values = { ...row, entityId: String(row.entityId) };
  if (values.idempotencyKey) await tx.insert(auditLogs).values(values).onDuplicateKeyUpdate({ set: { idempotencyKey: sql`idempotencyKey` } });
  else await tx.insert(auditLogs).values(values);
}

/** Evento de domínio dentro da transação; com `idempotencyKey`, repetir é no-op. */
export async function txEvent(tx: Tx, row: TxEventRow) {
  const values = { eventName: row.eventName, aggregateType: row.aggregateType, aggregateId: String(row.aggregateId), actorUserId: row.actorUserId, payload: JSON.stringify(row.payload), idempotencyKey: row.idempotencyKey ?? null };
  if (values.idempotencyKey) await tx.insert(domainEvents).values(values).onDuplicateKeyUpdate({ set: { idempotencyKey: sql`idempotencyKey` } });
  else await tx.insert(domainEvents).values(values);
}
