import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Tela de auditoria em MySQL real: filtros, paginação por id e acesso só de admin.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("tela de auditoria em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const caller = (role = "admin") => appRouter.createCaller({ user: { id: 1, role } } as never).auditTrail;

  it("filtra por tipo, registro e ação, pagina e não devolve a chave interna", async () => {
    const type = `teste_${runId}`;
    await db.insert(auditLogs).values([1, 2, 3].map(n => ({ actorUserId: null, entityType: type, entityId: `reg-${n}`, action: n === 3 ? `outra_${runId}` : `acao_${runId}`, summary: `linha ${n}`, idempotencyKey: `auditoria-teste:${runId}:${n}` })));
    const all = await caller().list({ entityType: type, limit: 2 });
    expect(all.rows.map(row => row.entityId)).toEqual(["reg-3", "reg-2"]);
    expect(all.nextCursor).not.toBeNull();
    expect(await caller().entityTypes()).toContain(type);
    const next = await caller().list({ entityType: type, limit: 2, cursor: all.nextCursor! });
    expect(next.rows.map(row => row.entityId)).toEqual(["reg-1"]);
    expect(next.nextCursor).toBeNull();
    expect((await caller().list({ entityType: type, action: "acao_" })).rows).toHaveLength(2);
    expect((await caller().list({ entityType: type, entityId: "reg-2" })).rows.map(row => row.summary)).toEqual(["linha 2"]);
    expect(JSON.stringify(all)).not.toContain("auditoria-teste");
  });

  it("só admin abre a trilha", async () => {
    for (const role of ["seller", "finance", "service", "user"]) await expect(caller(role).list({})).rejects.toThrow();
  });
});
