import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, domainEvents, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-A25 em MySQL real, pela rota do painel: só admin reenvia; o recibo de recusa ganha chave nova (a recusa fica na trilha), o painel
// deixa de contá-lo como recusado, o pedido registra quem reenviou, e o pedido de releitura vai para a ponte dona do recibo.
// A entrega em si (a ponte relê e entrega) está provada em financialBridgeStarvation.mysql.test.ts.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("reenviar recusado pelo painel de integrações (CRM-A25)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let rewind: typeof import("./bridgeRewind");
  let adminId: number;
  const previousEnv = { ...process.env };
  const as = (role: string) => appRouter.createCaller({ user: { id: adminId, role } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    rewind = await import("./bridgeRewind");
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `resend-${runId}`, name: "Admin reenvio", role: "admin" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  it("recusado do Relationship: admin reenvia, a recusa continua na trilha com chave nova, o painel não a conta mais e a ponte certa é mandada reler", async () => {
    const contractId = String(940_000_000 + Math.floor(Math.random() * 1_000_000));
    const [first] = await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: contractId, actorUserId: null, payload: JSON.stringify({ status: "active" }) }).$returningId();
    await db.insert(domainEvents).values({ eventName: "contract.status.updated", aggregateType: "contract", aggregateId: contractId, actorUserId: null, payload: JSON.stringify({ status: "cancelled" }) });
    const [receipt] = await db.insert(auditLogs).values({ actorUserId: null, entityType: "contract", entityId: contractId, action: "relationship_rejected", summary: `recusa sintética ${runId}`, idempotencyKey: `relationship-contract:${contractId}:active` }).$returningId();
    const before = (await as("admin").integrations.health()).bridges.find(item => item.key === "relationship")!;

    await expect(as("seller").integrations.resend({ receiptId: receipt.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("finance").integrations.resend({ receiptId: receipt.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rewind.takeBridgeRewind("relationship-contract:")).toBeNull();

    await expect(as("admin").integrations.resend({ receiptId: receipt.id })).resolves.toEqual({ bridge: "relationship", rewindTo: first.id });
    expect(rewind.takeBridgeRewind("relationship-contract:")).toBe(first.id);
    expect(rewind.takeBridgeRewind("sales-contract:")).toBeNull(); // a outra ponte de contrato não é mexida

    const [kept] = await db.select().from(auditLogs).where(eq(auditLogs.id, receipt.id));
    expect(kept).toMatchObject({ action: "relationship_rejected", summary: `recusa sintética ${runId}`, idempotencyKey: `resent:${receipt.id}:relationship-contract:${contractId}:active` });
    const requests = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `resend-request:${receipt.id}`));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ actorUserId: adminId, action: "integration_resend_requested", entityId: contractId });

    const after = (await as("admin").integrations.health()).bridges.find(item => item.key === "relationship")!;
    expect(after.rejected).toBeLessThanOrEqual(before.rejected - 1);
    expect(after.pending).toBeGreaterThanOrEqual(before.pending + 1); // o evento voltou a ficar sem recibo

    // Segundo clique: já reenviado.
    await expect(as("admin").integrations.resend({ receiptId: receipt.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("recibo que não é de recusa, ou que não existe, ou de evento que sumiu, não é reenviado", async () => {
    const [delivered] = await db.insert(auditLogs).values({ actorUserId: null, entityType: "integration_event", entityId: "1", action: "financial_delivered", summary: "entregue", idempotencyKey: `financial-event:ok-${runId}` }).$returningId();
    await expect(as("admin").integrations.resend({ receiptId: delivered.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as("admin").integrations.resend({ receiptId: 2_000_000_000 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ghostId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
    const [orphan] = await db.insert(auditLogs).values({ actorUserId: null, entityType: "integration_event", entityId: "x", action: "financial_rejected", summary: "sem evento", idempotencyKey: `financial-event:${ghostId}` }).$returningId();
    await expect(as("admin").integrations.resend({ receiptId: orphan.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db.select().from(auditLogs).where(eq(auditLogs.id, orphan.id)))[0]!.idempotencyKey).toBe(`financial-event:${ghostId}`);
  });
});
