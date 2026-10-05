import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { commercialFractions, commercialPolicyVersions, domainEvents, resorts, units } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { materializeSalesCommandSale } from "./salesCommandBridge";

// MySQL real: com mais de 500 eventos de contrato antes, um cancelamento novo ainda chega ao Sales Command 1×.
// Sem o cursor do pump, o tick relia sempre os mesmos 500 primeiros eventos e nunca entregava.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("Bridge de contrato do CRM em MySQL real: cursor além de 500 eventos", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let server: Server;
  let baseUrl = "";
  const received: { path: string; auth: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl; // getDb() do pump lê daqui
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        received.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: JSON.parse(raw) });
        res.writeHead(201, { "Content-Type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise(resolve => server?.close(resolve));
    await pool?.end();
  });

  it("entrega o cancelamento posterior a 501 eventos irrelevantes, uma única vez", async () => {
    const projectKey = randomUUID();
    const [resort] = await db.insert(resorts).values({ name: `SYN cursor ${runId}`, externalKey: projectKey }).$returningId();
    const [unit] = await db.insert(units).values({ resortId: resort.id, code: "U-CUR" }).$returningId();
    await db.insert(commercialPolicyVersions).values({
      resortId: resort.id, policyType: "sale_terms", version: "SYN-NAO-APROVADO",
      policyJson: JSON.stringify({ usageModel: "fixed_week", balanceInstallmentCount: 7, balanceCadenceMonths: 1 }),
      effectiveAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(commercialFractions).values({ resortId: resort.id, unitId: unit.id, code: "F-CUR-1", sequence: 1, listPrice: "19750.00" });

    const filler = Array.from({ length: 501 }, (_, i) => ({
      eventName: "contract.status.updated" as const, aggregateType: "contract", aggregateId: String(900_000_000 + i),
      actorUserId: null, payload: JSON.stringify({ status: "pending_signature" }), occurredAt: new Date(),
    }));
    await db.insert(domainEvents).values(filler);

    const saleId = randomUUID();
    const sale = await db.transaction(tx => materializeSalesCommandSale(tx, {
      eventId: `evt-${randomUUID()}`, eventName: "sale.ready_for_contract.v1", source: "sales-command",
      correlationId: `corr-${runId}`, occurredAt: "2026-10-04T15:30:00.000Z",
      project: { externalKey: projectKey, name: `SYN cursor ${runId}`, timezone: "America/Recife" },
      saleId, encounterId: randomUUID(), customer: { name: `Casal SYN ${runId}` },
      sale: {
        quotasCount: 1, vgvCents: 2_890_000, entryContractedCents: 320_000, entryReceivedCents: 320_000,
        entryInstallmentCount: 1, entrySchedule: [{ sequence: 1, amountCents: 320_000, dueDate: "2026-10-04" }],
        firstBalanceDueInDays: 30, paymentMethods: ["pix"],
      },
    } as never));
    await db.insert(domainEvents).values({
      eventName: "contract.status.updated", aggregateType: "contract", aggregateId: String(sale.contractId),
      actorUserId: null, payload: JSON.stringify({ status: "cancelled" }), occurredAt: new Date("2026-10-05T12:00:00.000Z"),
    });

    const { startSalesCancellationBridgePump } = await import("./relationshipBridge");
    const pump = startSalesCancellationBridgePump(baseUrl, "syn-cancel-key", { autoStart: false });
    const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM domain_events") as unknown as [[{ total: number }]];
    try {
      for (let i = 0; i <= Math.ceil(Number(total) / 500) + 1; i++) await pump.tick();
    } finally {
      pump.stop();
    }

    const mine = received.filter(r => r.body.saleId === saleId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      path: "/api/integration/crm/events",
      auth: "Bearer syn-cancel-key",
      body: { eventName: "crm.contract.cancelled.v1", contractId: String(sale.contractId), source: "crm" },
    });
  });
});
