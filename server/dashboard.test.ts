import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));

import { getDb } from "./db";
import { appRouter } from "./routers";

const mockedGetDb = vi.mocked(getDb);

function financeContext(): TrpcContext {
  return {
    user: { id: 99, openId: "finance-test", email: "finance@example.com", name: "Finance", loginMethod: "test", role: "finance", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => undefined } as TrpcContext["res"],
  };
}

function fakeDatabase(rows: unknown[]) {
  return {
    select: () => ({ from: () => ({ innerJoin: () => ({ leftJoin: async () => rows }) }) }),
  };
}

describe("dashboard.funnelDetails", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedGetDb.mockResolvedValue(fakeDatabase([
      { opportunity: { id: 1, stage: "proposal", sellerId: 1, closedAt: null, createdAt: new Date("2026-08-05T12:00:00Z") }, customerName: "Ana", sellerName: "Vendedor A" },
      { opportunity: { id: 2, stage: "proposal", sellerId: 2, closedAt: null, createdAt: new Date("2026-08-06T12:00:00Z") }, customerName: "Bia", sellerName: "Vendedor B" },
      { opportunity: { id: 3, stage: "negotiation", sellerId: 1, closedAt: null, createdAt: new Date("2026-08-08T12:00:00Z") }, customerName: "Caio", sellerName: "Vendedor A" },
      { opportunity: { id: 4, stage: "proposal", sellerId: 1, closedAt: null, createdAt: new Date("2026-07-28T12:00:00Z") }, customerName: "Dani", sellerName: "Vendedor A" },
    ]) as never);
  });

  it("devolve apenas a proposta da etapa, período e vendedor selecionados", async () => {
    const caller = appRouter.createCaller(financeContext());
    const sellerOne = await caller.dashboard.funnelDetails({ stage: "proposal", startDate: "2026-08-01", endDate: "2026-08-31", sellerId: 1 });
    const allSellers = await caller.dashboard.funnelDetails({ stage: "proposal", startDate: "2026-08-01", endDate: "2026-08-31" });
    const negotiation = await caller.dashboard.funnelDetails({ stage: "negotiation", startDate: "2026-08-01", endDate: "2026-08-31", sellerId: 1 });
    expect(sellerOne.map(item => item.opportunity.id)).toEqual([1]);
    expect(allSellers.map(item => item.opportunity.id)).toEqual([1, 2]);
    expect(negotiation.map(item => item.opportunity.id)).toEqual([3]);
  });
});
