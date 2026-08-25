import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { contracts, resorts, units } from "../drizzle/schema";
import { ownershipRouter } from "./routers/ownership";

function query(rows: unknown[]) {
  return { from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => rows) })) })) };
}

function makeDb(options: { contracts?: unknown[]; resorts?: unknown[]; units?: unknown[] } = {}) {
  const inserted: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => table === contracts ? query(options.contracts ?? [{ id: 61 }]).from() : table === resorts ? query(options.resorts ?? [{ id: 2 }]).from() : table === units ? query(options.units ?? [{ id: 51, resortId: 2 }]).from() : query([]).from()),
    })),
    insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { inserted.push(value); return { $returningId: async () => [{ id: 901 }] }; }) })),
  };
  return { db, inserted };
}

describe("integridade de direitos de uso", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita contrato inexistente sem inserir", async () => {
    const fixture = makeDb({ contracts: [] });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = ownershipRouter.createCaller({ user: { id: 72, role: "service" } } as never);

    await expect(caller.createEntitlement({ contractId: 61, entitlementType: "points", annualPoints: 100, priorityLevel: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
  });

  it("rejeita unidade de empreendimento diferente", async () => {
    const fixture = makeDb({ units: [{ id: 51, resortId: 9 }] });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = ownershipRouter.createCaller({ user: { id: 72, role: "service" } } as never);

    await expect(caller.createEntitlement({ contractId: 61, resortId: 2, unitId: 51, entitlementType: "points", annualPoints: 100, priorityLevel: 2 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.inserted).toEqual([]);
  });

  it("rejeita vigência invertida", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = ownershipRouter.createCaller({ user: { id: 72, role: "service" } } as never);

    await expect(caller.createEntitlement({ contractId: 61, entitlementType: "points", annualPoints: 100, priorityLevel: 2, validFrom: "2027-01-01", validUntil: "2026-01-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.inserted).toEqual([]);
  });

  it("cria e audita direito válido", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = ownershipRouter.createCaller({ user: { id: 72, role: "service" } } as never);

    await expect(caller.createEntitlement({ contractId: 61, resortId: 2, unitId: 51, entitlementType: "points", annualPoints: 100, priorityLevel: 2, validFrom: "2026-01-01", validUntil: "2027-01-01" })).resolves.toEqual({ id: 901 });
    expect(fixture.inserted[0]).toMatchObject({ contractId: 61, resortId: 2, unitId: 51, annualPoints: 100 });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(72, "ownership_entitlement", 901, "created", expect.stringContaining("points"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "ownership.entitlement.created", aggregateId: 901 }));
  });
});

void units;

