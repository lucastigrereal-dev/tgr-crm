import { beforeEach, describe, expect, it, vi } from "vitest";
import { contracts, opportunities, salesCampaigns, salesCommissions, users } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { commissionsRouter } from "./routers/commissions";

function makeDb({ sellerExists = true, campaignExists = true, opportunityExists = true, contractExists = true } = {}) {
  const inserted: unknown[] = [];
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          if (table === users) return sellerExists ? [{ id: 55 }] : [];
          if (table === salesCampaigns) return campaignExists ? [{ id: 10 }] : [];
          if (table === opportunities) return opportunityExists ? [{ id: 20 }] : [];
          if (table === contracts) return contractExists ? [{ id: 30 }] : [];
          return [];
        }),
      })),
    })),
  }));
  const insert = vi.fn(() => ({ values: vi.fn((value: unknown) => { inserted.push(value); return { $returningId: async () => [{ id: 901 }] }; }) }));
  return { db: { select, insert }, inserted, insert };
}

function caller() {
  return commissionsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

const baseInput = { sellerId: 55, baseAmount: 1000, rate: 10, notes: "Lançamento manual" };

describe("integridade do lançamento manual de comissão", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita vendedor inexistente antes do insert", async () => {
    const fixture = makeDb({ sellerExists: false });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record(baseInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita referência opcional de campanha inexistente", async () => {
    const fixture = makeDb({ campaignExists: false });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record({ ...baseInput, campaignId: 10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("cria comissão válida e audita o ID persistido", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().record(baseInput)).resolves.toEqual({ id: 901, amount: 100 });
    expect(fixture.inserted[0]).toMatchObject({ sellerId: 55, baseAmount: "1000.00", rate: "10.00", amount: "100.00" });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_commission", 901, "created", "Comissão de 100.00 lançada.");
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith({ eventName: "commission.created", aggregateType: "sales_commission", aggregateId: 901, actorUserId: 55, payload: { sellerId: 55, campaignId: null, opportunityId: null, contractId: null, amount: 100, rate: 10 } });
  });
});

