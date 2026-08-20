import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
import { getDb } from "./db";
import { appRouter } from "./routers";

const mockedGetDb = vi.mocked(getDb);
function chain<T>(value: T) { const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>; for (const method of ["from", "where", "orderBy", "limit"]) promise[method] = () => promise; return promise; }
function caller(role: "admin" | "seller") { return appRouter.createCaller({ user: { id: 3, role } } as never); }

describe("integrations.eventFeed", () => {
  beforeEach(() => vi.resetAllMocks());
  it("entrega somente envelope allowlistado para administrador", async () => {
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => chain([{ id: 7, eventName: "customer.updated", aggregateType: "customer", aggregateId: "8", actorUserId: 3, occurredAt: new Date("2026-08-20T12:00:00Z"), payload: JSON.stringify({ status: "active", email: "privado@example.com" }) }])) } as never);
    const result = await caller("admin").integrations.eventFeed({ limit: 10 });
    expect(result).toMatchObject({ contractVersion: "tse.events.v1", events: [{ eventId: 7, eventName: "customer.updated", payload: { status: "active" } }] });
    expect(result.events[0]?.payload).not.toHaveProperty("email");
  });
  it("bloqueia o feed para perfil operacional sem privilégio administrativo", async () => {
    await expect(caller("seller").integrations.contract()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
