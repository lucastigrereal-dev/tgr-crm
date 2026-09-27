import { createServer } from "node:http";
import { createServer as createPortServer } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./revenueQualitySync", () => ({ syncRevenueQualityForContract: vi.fn() }));
import { getDb } from "./db";
import { registerSalesCommandBridge } from "./salesCommandBridge";

const mockedGetDb = vi.mocked(getDb);

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
      entryReceivedCents: 180_000,
      entryInstallmentCount: 2,
      entrySchedule: [
        { sequence: 1, amountCents: 180_000, dueDate: "2026-09-25" },
        { sequence: 2, amountCents: 180_000, dueDate: "2026-10-25" },
      ],
      firstBalanceDueInDays: 120,
      paymentMethods: ["PIX"],
    },
  };
}

async function withApp(run: (base: string) => Promise<void>, key: string | undefined = "sales-command-test-key") {
  const app = express();
  app.use(express.json());
  registerSalesCommandBridge(app, key);
  const port = await freePort();
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  try { await run("http://127.0.0.1:" + port); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("Sales Command to CRM HTTP boundary", () => {
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

  it("rejects an incomplete commercial snapshot before touching the database", async () => {
    const body = canonicalBody();
    const { entrySchedule: _entrySchedule, ...sale } = body.sale;
    await withApp(async base => {
      const response = await fetch(base + "/api/integrations/sales-command", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sales-command-test-key" },
        body: JSON.stringify({ ...body, sale }),
      });
      expect(response.status).toBe(400);
      expect(mockedGetDb).not.toHaveBeenCalled();
    });
  });

  it("rejects an invalid IANA project time zone before touching the database", async () => {
    const body = canonicalBody();
    body.project.timezone = "America/Recfie";
    await withApp(async base => {
      const response = await fetch(base + "/api/integrations/sales-command", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sales-command-test-key" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(mockedGetDb).not.toHaveBeenCalled();
    });
  });

  it("rejects an impossible entry calendar date before touching the database", async () => {
    const body = canonicalBody();
    body.sale.entrySchedule[0]!.dueDate = "2026-02-30";
    await withApp(async base => {
      const response = await fetch(base + "/api/integrations/sales-command", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sales-command-test-key" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(mockedGetDb).not.toHaveBeenCalled();
    });
  });

  it("fails closed when the integration key is not configured", async () => {
    await withApp(async base => {
      const response = await fetch(base + "/api/integrations/sales-command", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sales-command-test-key" },
        body: JSON.stringify(canonicalBody()),
      });
      expect(response.status).toBe(503);
      expect(mockedGetDb).not.toHaveBeenCalled();
    }, "");
  });
});
