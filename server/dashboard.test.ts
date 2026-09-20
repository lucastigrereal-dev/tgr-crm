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

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, () => unknown>;
  promise.where = () => promise;
  promise.limit = () => promise;
  return promise;
}

function fakeDatabase(rows: unknown[], captures: unknown[] = []) {
  let selectCount = 0;
  return {
    select: () => {
      selectCount += 1;
      return selectCount % 2 === 0
        ? { from: () => ({ where: () => chain(captures) }) }
        : { from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: () => chain(rows) }) }) }) };
    },
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
    expect(sellerOne.rows.map(item => item.opportunity.id)).toEqual([1]);
    expect(allSellers.rows.map(item => item.opportunity.id)).toEqual([1, 2]);
    expect(negotiation.rows.map(item => item.opportunity.id)).toEqual([3]);
    expect(sellerOne.truncated).toBe(false);
  });

  it("sinaliza amostra limitada no drill-down sem esconder as linhas retornadas", async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({ opportunity: { id: index + 1, stage: "proposal", sellerId: 1, campaignId: null, closedAt: null, createdAt: new Date("2026-08-05T12:00:00Z") }, customerName: `Cliente ${index + 1}`, sellerName: "Vendedor A" }));
    mockedGetDb.mockResolvedValue(fakeDatabase(rows, []) as never);
    const caller = appRouter.createCaller(financeContext());

    const result = await caller.dashboard.funnelDetails({ stage: "proposal", startDate: "2026-08-01", endDate: "2026-08-31" });

    expect(result.rows).toHaveLength(5000);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["oportunidades"]);
  });

  it("mantém funil e drill-down no mesmo recorte operacional da ficha mais recente", async () => {
    mockedGetDb.mockResolvedValue(fakeDatabase([
      { opportunity: { id: 1, stage: "proposal", sellerId: 1, closedAt: null, createdAt: new Date("2026-08-05T12:00:00Z") }, customerName: "Ana", sellerName: "Vendedor A" },
      { opportunity: { id: 2, stage: "proposal", sellerId: 2, closedAt: null, createdAt: new Date("2026-08-06T12:00:00Z") }, customerName: "Bia", sellerName: "Vendedor B" },
    ], [
      { id: 10, opportunityId: 1, resortId: 11, salesRoom: "Sala Azul", presentationStatus: "scheduled", createdAt: new Date("2026-08-01T10:00:00Z") },
      { id: 11, opportunityId: 1, resortId: 11, salesRoom: "Sala Azul", presentationStatus: "presented", createdAt: new Date("2026-08-07T10:00:00Z") },
      { id: 12, opportunityId: 2, resortId: 22, salesRoom: "Sala Ouro", presentationStatus: "no_tour", createdAt: new Date("2026-08-08T10:00:00Z") },
    ]) as never);
    const caller = appRouter.createCaller(financeContext());
    const recorte = await caller.dashboard.funnelDetails({ stage: "proposal", startDate: "2026-08-01", endDate: "2026-08-31", resortId: 11, salesRoom: "Sala Azul", presentationStatus: "presented" });
    const etapaAntiga = await caller.dashboard.funnelDetails({ stage: "proposal", startDate: "2026-08-01", endDate: "2026-08-31", resortId: 11, presentationStatus: "scheduled" });
    const outraEquipe = await caller.dashboard.funnelDetails({ stage: "proposal", startDate: "2026-08-01", endDate: "2026-08-31", sellerId: 2, resortId: 11, salesRoom: "Sala Azul", presentationStatus: "presented" });
    expect(recorte.rows.map(item => item.opportunity.id)).toEqual([1]);
    expect(etapaAntiga.rows).toEqual([]);
    expect(outraEquipe.rows).toEqual([]);
  });

  it("mantém o dashboard restrito a perfis internos", async () => {
    const externalContext = financeContext();
    externalContext.user = { ...externalContext.user!, role: "user" };
    const caller = appRouter.createCaller(externalContext);
    await expect(caller.dashboard.funnelDetails({ stage: "proposal", startDate: "2026-08-01", endDate: "2026-08-31" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
