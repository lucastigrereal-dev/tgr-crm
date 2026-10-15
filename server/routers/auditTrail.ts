import { and, desc, eq, gte, like, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, users } from "../../drizzle/schema";
import { router } from "../_core/trpc";
import { getDb } from "../db";
import { adminProcedure } from "./access";

const escapeLike = (value: string) => value.replace(/[\\%_]/g, char => `\\${char}`);

const listInput = z.object({
  entityType: z.string().trim().min(1).max(80).optional(),
  entityId: z.string().trim().min(1).max(80).optional(),
  action: z.string().trim().min(1).max(80).optional(),
  actorUserId: z.number().int().positive().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

// Tela de auditoria (TSE): leitura da trilha append-only, mais nova primeiro, paginada por id. Só admin; não escreve nada
// e não devolve a chave de idempotência (é detalhe interno das pontes).
export const auditTrailRouter = router({
  list: adminProcedure.input(listInput).query(async ({ input }) => {
    const db = await getDb(); if (!db) return { rows: [], nextCursor: null };
    const where = and(
      input.entityType ? eq(auditLogs.entityType, input.entityType) : undefined,
      input.entityId ? eq(auditLogs.entityId, input.entityId) : undefined,
      input.action ? like(auditLogs.action, `${escapeLike(input.action)}%`) : undefined,
      input.actorUserId ? eq(auditLogs.actorUserId, input.actorUserId) : undefined,
      input.from ? gte(auditLogs.createdAt, input.from) : undefined,
      input.to ? lte(auditLogs.createdAt, input.to) : undefined,
      input.cursor ? lt(auditLogs.id, input.cursor) : undefined,
    );
    const rows = await db.select({ id: auditLogs.id, actorUserId: auditLogs.actorUserId, actorName: users.name, entityType: auditLogs.entityType, entityId: auditLogs.entityId, action: auditLogs.action, summary: auditLogs.summary, createdAt: auditLogs.createdAt })
      .from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorUserId)).where(where).orderBy(desc(auditLogs.id)).limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    return { rows: page, nextCursor: rows.length > input.limit ? page[page.length - 1].id : null };
  }),
  // Tipos de registro para o filtro: consulta à parte, que a tela pede uma vez só (não a cada página ou tecla).
  entityTypes: adminProcedure.query(async () => {
    const db = await getDb(); if (!db) return [] as string[];
    const types = await db.selectDistinct({ entityType: auditLogs.entityType }).from(auditLogs).orderBy(auditLogs.entityType).limit(200);
    return types.map(row => row.entityType);
  }),
});
