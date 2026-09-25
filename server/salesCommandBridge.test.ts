import { createServer } from "node:http";
import { createServer as createPortServer } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
import { getDb } from "./db";
import { registerSalesCommandBridge } from "./salesCommandBridge";

const mockedGetDb = vi.mocked(getDb);

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
  for (const method of ["from", "where", "orderBy", "limit"]) promise[method] = () => promise;
  return promise;
}

async function freePort() {
  const socket = createPortServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("listening", resolve);
    socket.once("error", reject);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return address.port;
}

function canonicalBody() {
  return {
    eventId: "sales-event-001",
    eventName: "sale.ready_for_contract.v1",
    source: "sales-command",
    correlationId: "corr-sales-crm-001",
    occurredAt: "2026-09-25T12:00:00.000Z",
    project: {
      externalKey: "22222222-2222-2222-2222-222222222222",
      name: "Ponta Negra Eco Resort",
      timezone: "America/Recife",
    },
    saleId: "44444444-4444-4444-4444-444444444444",
    encounterId: "55555555-5555-5555-5555-555555555555",
    customer: { name: "Ana & Bruno" },
    sale: {
      quotasCount: 1,
      vgvCents: 2_890_000,
      entryContractedCents: 360_000,
      entryReceivedCents: 360_000,
      entryInstallmentCount: 1,
      firstBalanceDueInDays: 120,
      paymentMethods: ["PIX"],
    },
  };
}

async function withApp(run: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerSalesCommandBridge(app, "sales-command-test-key");
  const port = await freePort();
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  try { await run("http://127.0.0.1:" + port); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

function firstDeliveryDb() {
  const inserted: Array<Record<string, unknown>> = [];
  let insertCount = 0;
  const tx = {
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        insertCount += 1;
        inserted.push(values);
        const id = insertCount === 1 ? 101 : insertCount === 2 ? 202 : undefined;
        const result = Promise.resolve(undefined) as Promise<unknown> & { $returningId: () => Promise<Array<{ id: number }>> };
        result.$returningId = async () => id ? [{ id }] : [];
        return result;
      },
    })),
  };
  const db = {
    select: vi.fn(() => chain([])),
    transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { db, inserted };
}

describe("Sales Command to CRM bridge", () => {
  afterEach(() => vi.resetAllMocks());

  it("rejects an invalid bearer before touching the database", async () => {
    await withApp(async base => {
      const response = await fetch(base + "/api/integrations/sales-command", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-key" },
        body: JSON.stringify(canonicalBody()),
      });
      expect(response.status).toBe(401);
      expect(mockedGetDb).not.toHaveBeenCalled();
    });
  });

  it("ingests one canonical sale idempotently without manufacturing a contract", async () => {
    const first = firstDeliveryDb();
    mockedGetDb.mockResolvedValue(first.db as never);
    await withApp(async base => {
      const response = await fetch(base + "/api/integrations/sales-command", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sales-command-test-key" },
        body: JSON.stringify(canonicalBody()),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        accepted: true,
        replay: false,
        customerId: 101,
        opportunityId: 202,
        saleId: "44444444-4444-4444-4444-444444444444",
      });
    });
    expect(first.inserted).toHaveLength(4);
    expect(first.inserted[0]).toMatchObject({ fullName: "Ana & Bruno", acquisitionSource: "Sales Command", status: "prospect" });
    expect(first.inserted[1]).toMatchObject({ customerId: 101, stage: "proposal", source: "Sales Command", probability: 100 });
    expect(first.inserted[2]).toMatchObject({
      eventName: "sales.command.sale.ingested",
      aggregateType: "opportunity",
      aggregateId: "202",
      idempotencyKey: "sales-command:sales-event-001",
    });
    const lineage = JSON.parse(String(first.inserted[2]?.payload));
    expect(lineage).toMatchObject({
      customerId: 101,
      saleId: "44444444-4444-4444-4444-444444444444",
      projectExternalKey: "22222222-2222-2222-2222-222222222222",
      vgvCents: 2_890_000,
    });
  });

  it("returns the original CRM ids on replay and performs no second transaction", async () => {
    const transaction = vi.fn();
    mockedGetDb.mockResolvedValue({
      select: vi.fn(() => chain([{
        aggregateId: "202",
        payload: JSON.stringify({ customerId: 101, saleId: "44444444-4444-4444-4444-444444444444" }),
      }])),
      transaction,
    } as never);
    await withApp(async base => {
      const response = await fetch(base + "/api/integrations/sales-command", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sales-command-test-key" },
        body: JSON.stringify(canonicalBody()),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        accepted: true,
        replay: true,
        opportunityId: 202,
        customerId: 101,
        saleId: "44444444-4444-4444-4444-444444444444",
      });
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
