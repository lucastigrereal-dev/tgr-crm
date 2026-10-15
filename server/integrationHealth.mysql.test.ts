import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, domainEvents } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Painel de falhas das integrações (TSE #34) em MySQL real. Outros testes usam o mesmo banco e as pontes deles podem
// entregar eventos sem recibo, então os números do painel são conferidos como "no mínimo o que gravei" e o pendente é
// semeado de novo a cada tentativa.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("painel de integrações em MySQL real", () => {
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

  const health = (role = "admin") => appRouter.createCaller({ user: { id: 1, role } } as never).integrations.health();
  const bridge = async (key: string, role?: string) => (await health(role)).bridges.find(item => item.key === key)!;
  const seedEvent = async (aggregateId: string, occurredAt: Date) => {
    const [{ id }] = await db.insert(domainEvents).values({ eventName: "installment.paid", aggregateType: "installment", aggregateId, payload: JSON.stringify({ installmentId: 1 }), occurredAt }).$returningId();
    return id;
  };

  it("conta entregues, recusados e não se aplica pelos recibos, e lista o recusado com o motivo", async () => {
    const before = { financial: await bridge("financial"), relationship: await bridge("relationship"), sales: await bridge("salesCancellation") };
    const refused = await seedEvent(`recusado-${runId}`, new Date());
    await db.insert(auditLogs).values([
      { actorUserId: null, entityType: "integration_event", entityId: String(refused), action: "financial_rejected", summary: `installment.paid recusado pelo TGR Financial Layer (HTTP 422, code TESTE_${runId})`, idempotencyKey: `financial-event:${refused}` },
      { actorUserId: null, entityType: "integration_event", entityId: "9001", action: "financial_delivered", summary: "entregue", idempotencyKey: `financial-event:delivered-${runId}` },
      { actorUserId: null, entityType: "contract", entityId: `7${runId}`, action: "relationship_not_applicable", summary: "sem linhagem", idempotencyKey: `relationship-contract:na-${runId}:active` },
      { actorUserId: null, entityType: "contract", entityId: `8${runId}`, action: "sales_sale_validated_rejected", summary: `sale.validated sem os portões (${runId})`, idempotencyKey: `sales-contract:rej-${runId}:validated` },
      { actorUserId: null, entityType: "contract", entityId: `9${runId}`, action: "sales_cancellation_delivered", summary: "entregue", idempotencyKey: `sales-contract:ok-${runId}:cancelled` },
    ]);
    const after = await health();
    const financial = after.bridges.find(item => item.key === "financial")!;
    const relationship = after.bridges.find(item => item.key === "relationship")!;
    const sales = after.bridges.find(item => item.key === "salesCancellation")!;
    expect(financial.rejected).toBeGreaterThanOrEqual(before.financial.rejected + 1);
    expect(financial.delivered).toBeGreaterThanOrEqual(before.financial.delivered + 1);
    expect(relationship.notApplicable).toBeGreaterThanOrEqual(before.relationship.notApplicable + 1);
    expect(sales.rejected).toBeGreaterThanOrEqual(before.sales.rejected + 1);
    expect(sales.delivered).toBeGreaterThanOrEqual(before.sales.delivered + 1);
    // Cada ponte só conta os recibos do próprio prefixo: o recusado do Sales não entra no Relationship.
    expect(relationship.rejected).toBe(before.relationship.rejected);
    const listed = after.rejected.filter(row => row.summary?.includes(runId));
    expect(listed.map(row => row.bridge).sort()).toEqual(["TGR Financial Layer", "TGR Sales Command"]);
    expect(listed.find(row => row.bridge === "TGR Financial Layer")).toMatchObject({ action: "financial_rejected", entityId: String(refused) });
    expect(after.rejected.every(row => row.action.endsWith("_rejected"))).toBe(true);
  });

  it("evento sem recibo aparece como pendente; o antigo conta como parado e o que tem recibo sai da fila", async () => {
    let seen = false;
    for (let attempt = 0; attempt < 5 && !seen; attempt += 1) {
      const old = await seedEvent(`parado-${runId}-${attempt}`, new Date(Date.now() - 60 * 60_000));
      const snapshot = await bridge("financial");
      if (snapshot.pending >= 1 && snapshot.stuck >= 1 && snapshot.oldestPendingAt && snapshot.oldestPendingAt.getTime() <= Date.now() - 55 * 60_000) {
        seen = true;
        // Com recibo, o evento deixa de contar como pendente.
        const stuckBefore = snapshot.stuck;
        await db.insert(auditLogs).values({ actorUserId: null, entityType: "integration_event", entityId: String(old), action: "financial_delivered", summary: "entregue", idempotencyKey: `financial-event:${old}` });
        const settled = await bridge("financial");
        expect(settled.stuck).toBeLessThanOrEqual(stuckBefore - 1);
      }
    }
    expect(seen).toBe(true);
  });

  it("evento fora da janela de 30 dias não entra no pendente, e o painel é só do administrador", async () => {
    const ancient = await seedEvent(`antigo-${runId}`, new Date(Date.now() - 40 * 24 * 60 * 60_000));
    const pendingOldest = (await bridge("financial")).oldestPendingAt;
    expect(pendingOldest === null || pendingOldest.getTime() > Date.now() - 31 * 24 * 60 * 60_000).toBe(true);
    await db.insert(auditLogs).values({ actorUserId: null, entityType: "integration_event", entityId: String(ancient), action: "financial_delivered", summary: "limpeza", idempotencyKey: `financial-event:${ancient}` });
    for (const role of ["service", "seller", "finance"]) await expect(health(role)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const result = await health();
    expect(JSON.stringify(result)).not.toMatch(/Bearer|integrationKey|apiKey/i);
    expect(result.bridges.map(item => typeof item.configured)).toEqual(["boolean", "boolean", "boolean"]);
  });
});
