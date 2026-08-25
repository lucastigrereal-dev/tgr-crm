import { asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, auditLogs, domainEvents, users } from "../drizzle/schema";
import type { DomainEventName } from "../shared/domainEvents";
import { ENV } from "./_core/env";
import { logger } from "./logger";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      logger.warn("Database initialization failed", { error: error instanceof Error ? error.message : "unknown_error" });
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = { lastSignedIn: new Date() };
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  values.lastSignedIn = new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(users).where(eq(users.openId, openId)).limit(1))[0];
}

export async function recordAudit(actorUserId: number | null, entityType: string, entityId: number | string, action: string, summary?: string) {
  const db = await getDb();
  if (!db) return;
  await db.insert(auditLogs).values({ actorUserId, entityType, entityId: String(entityId), action, summary: summary ?? null });
}

export async function recordDomainEvent(input: {
  eventName: DomainEventName;
  aggregateType: string;
  aggregateId: number | string;
  actorUserId?: number | null;
  payload?: Record<string, unknown>;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(domainEvents).values({
    eventName: input.eventName,
    aggregateType: input.aggregateType,
    aggregateId: String(input.aggregateId),
    actorUserId: input.actorUserId ?? null,
    payload: input.payload ? JSON.stringify(input.payload) : null,
  });
}

export async function recentAudit(limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
}
