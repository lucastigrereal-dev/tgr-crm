import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { ownershipRouter } from "./routers/ownership";

describe("listas de ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("entrega bloqueios com a identificação da unidade e do empreendimento", async () => {
    const rows = [{ block: { id: 41, unitId: 8, startsAt: new Date("2026-10-10T12:00:00Z"), endsAt: new Date("2026-10-12T12:00:00Z"), reason: "Pintura", status: "planned" }, unitCode: "803", resortName: "Águas do Tigre" }];
    const limit = vi.fn(async (value: number) => {
      expect(value).toBe(101);
      return rows;
    });
    const db = {
      select: vi.fn(() => ({ from: () => ({ innerJoin: () => ({ innerJoin: () => ({ orderBy: () => ({ limit }) }) }) }) })),
    };
    dbMocks.getDb.mockResolvedValue(db);

    const caller = ownershipRouter.createCaller({ user: { id: 8, role: "service" } } as never);
    await expect(caller.listMaintenanceBlocks()).resolves.toEqual({ rows, truncated: false, truncatedSources: [] });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("marca bloqueios quando supera o limite operacional", async () => {
    const rows = Array.from({ length: 101 }, (_, id) => ({ block: { id, unitId: 8 }, unitCode: "803", resortName: "Resort" }));
    const limit = vi.fn(async (value: number) => {
      expect(value).toBe(101);
      return rows;
    });
    dbMocks.getDb.mockResolvedValue({ select: vi.fn(() => ({ from: () => ({ innerJoin: () => ({ innerJoin: () => ({ orderBy: () => ({ limit }) }) }) }) })) });
    const caller = ownershipRouter.createCaller({ user: { id: 8, role: "service" } } as never);

    const result = await caller.listMaintenanceBlocks();
    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["bloqueios de manutenção"]);
  });

  it("marca direitos quando supera o limite operacional", async () => {
    const rows = Array.from({ length: 1001 }, (_, id) => ({ id, contractId: 19, entitlementType: "flexible_week" }));
    const limit = vi.fn(async (value: number) => {
      expect(value).toBe(1001);
      return rows;
    });
    dbMocks.getDb.mockResolvedValue({ select: vi.fn(() => ({ from: () => ({ limit }) })) });
    const caller = ownershipRouter.createCaller({ user: { id: 8, role: "service" } } as never);

    const result = await caller.listEntitlements();
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["direitos de uso"]);
  });
});

export {};
