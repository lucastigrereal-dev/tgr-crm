import { beforeEach, describe, expect, it, vi } from "vitest";
import { commercialFractionHistory, commercialFractionHolds, commercialFractions, resorts, units } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { inventoryRouter } from "./routers/inventory";

function query(rows: unknown[]) {
  const result = Promise.resolve(rows);
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.where = self;
  chain.orderBy = self;
  chain.innerJoin = self;
  chain.leftJoin = self;
  chain.limit = () => ({ for: async () => rows, then: result.then.bind(result) });
  chain.for = async () => rows;
  chain.then = result.then.bind(result);
  return chain;
}

describe("estoque comercial de cotas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("materializa 52 cotas por UH sem duplicar códigos existentes", async () => {
    const inserted: unknown[][] = [];
    const db = {
      select: vi.fn(() => ({ from: (table: unknown) => {
        if (table === resorts) return query([{ id: 1, name: "Ponta Negra Eco Resort" }]);
        if (table === units) return query([{ id: 10, code: "UH-101" }, { id: 11, code: "UH-102" }]);
        if (table === commercialFractions) return query([{ code: "UH-101-C01" }]);
        return query([]);
      } })),
      insert: vi.fn(() => ({ values: vi.fn(async (value: unknown[]) => { inserted.push(value); }) })),
    };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = inventoryRouter.createCaller({ user: { id: 7, role: "admin" } } as never);

    await expect(caller.bootstrap({ resortId: 1, fractionsPerUnit: 52, listPrice: 28900, priceTableVersion: "NATAL-2026-01" }))
      .resolves.toEqual({ created: 103, units: 2, expectedTotal: 104 });

    const values = inserted.flat();
    expect(values).toHaveLength(103);
    expect(values).toContainEqual(expect.objectContaining({ unitId: 10, code: "UH-101-C02", sequence: 2, listPrice: "28900.00" }));
    expect(values).toContainEqual(expect.objectContaining({ unitId: 11, code: "UH-102-C52", sequence: 52 }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(7, "commercial_inventory", 1, "bootstrapped", expect.stringContaining("103 novas cotas"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commercial.inventory.bootstrapped" }));
  });

  it("cria hold sob lock e move a cota disponível para held", async () => {
    const updates: unknown[] = [];
    const inserts: Array<{ table: unknown; value: unknown }> = [];
    const fraction = { id: 41, status: "available", currentProposalId: null, heldUntil: null };
    const tx = {
      select: vi.fn(() => ({ from: (table: unknown) => {
        if (table === commercialFractions) return query([fraction]);
        if (table === commercialFractionHolds) return query([]);
        return query([]);
      } })),
      update: vi.fn((table: unknown) => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push({ table, value }); return { affectedRows: 1 }; }) })) })),
      insert: vi.fn((table: unknown) => ({ values: vi.fn((value: unknown) => {
        inserts.push({ table, value });
        return { $returningId: async () => table === commercialFractionHolds ? [{ id: 88 }] : [{ id: 1 }] };
      }) })),
    };
    const db = { transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = inventoryRouter.createCaller({ user: { id: 9, role: "seller" } } as never);

    const result = await caller.createHold({ fractionId: 41, ttlMinutes: 30 });
    expect(result).toMatchObject({ holdId: 88, reused: false });
    expect(inserts.some(item => item.table === commercialFractionHolds)).toBe(true);
    expect(inserts.some(item => item.table === commercialFractionHistory)).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({ table: commercialFractions, value: expect.objectContaining({ status: "held" }) }));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commercial.fraction.status.changed", aggregateId: 41 }));
  });

  it("rejeita hold para cota já vendida antes de qualquer escrita", async () => {
    const tx = {
      select: vi.fn(() => ({ from: (table: unknown) => table === commercialFractions ? query([{ id: 41, status: "sold" }]) : query([]) })),
      update: vi.fn(),
      insert: vi.fn(),
    };
    const db = { transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)) };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = inventoryRouter.createCaller({ user: { id: 9, role: "seller" } } as never);

    await expect(caller.createHold({ fractionId: 41, ttlMinutes: 30 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});
