import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { ownershipRouter } from "./routers/ownership";

describe("ownership.listMaintenanceBlocks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("entrega bloqueios com a identificação da unidade e do empreendimento", async () => {
    const rows = [{ block: { id: 41, unitId: 8, startsAt: new Date("2026-10-10T12:00:00Z"), endsAt: new Date("2026-10-12T12:00:00Z"), reason: "Pintura", status: "planned" }, unitCode: "803", resortName: "Águas do Tigre" }];
    const db = {
      select: vi.fn(() => ({ from: () => ({ innerJoin: () => ({ innerJoin: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }) })),
    };
    dbMocks.getDb.mockResolvedValue(db);

    const caller = ownershipRouter.createCaller({ user: { id: 8, role: "service" } } as never);
    await expect(caller.listMaintenanceBlocks()).resolves.toEqual(rows);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
