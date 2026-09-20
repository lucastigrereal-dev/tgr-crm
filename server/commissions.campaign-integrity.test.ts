import { beforeEach, describe, expect, it, vi } from "vitest";
import { salesCampaigns } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { commissionsRouter } from "./routers/commissions";

function makeDb({ existingCampaign = false } = {}) {
  const inserted: unknown[] = [];
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => existingCampaign ? [{ id: 800 }] : []) })) })) }));
  const insert = vi.fn(() => ({ values: vi.fn((value: unknown) => { inserted.push(value); return { $returningId: async () => [{ id: 901 }] }; }) }));
  return { db: { select, insert }, inserted };
}

function caller() {
  return commissionsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

const baseInput = { name: "Campanha Verão", code: "verao 2026", description: "Campanha sazonal", commissionRate: 5, targetAmount: 100000, status: "draft" as const };

describe("integridade de calendário de campanhas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita data de início calendariamente impossível antes do insert", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().createCampaign({ ...baseInput, startsAt: "2026-02-30" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita fim anterior ao início antes do insert", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().createCampaign({ ...baseInput, startsAt: "2026-12-01", endsAt: "2026-11-30" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita código de campanha duplicado antes do insert", async () => {
    const fixture = makeDb({ existingCampaign: true });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().createCampaign({ ...baseInput, startsAt: "2026-11-01", endsAt: "2026-12-31" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("cria campanha com intervalo válido e normaliza o código", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().createCampaign({ ...baseInput, startsAt: "2026-11-01", endsAt: "2026-12-31" })).resolves.toEqual({ id: 901 });
    expect(fixture.inserted[0]).toMatchObject({ code: "VERAO-2026", commissionRate: "5.00", targetAmount: "100000.00" });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_campaign", 901, "created", expect.stringContaining("VERAO-2026"));
  });
});

