import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { capturesRouter } from "./routers/captures";

function chain(rows: unknown[], limitCalls: number[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, ReturnType<typeof vi.fn>>;
  for (const method of ["from", "where", "orderBy", "innerJoin", "leftJoin"]) promise[method] = vi.fn(() => promise);
  promise.limit = vi.fn((value: number) => {
    limitCalls.push(value);
    return Promise.resolve(rows);
  });
  return promise;
}

function makeDb(responses: unknown[]) {
  const limitCalls: number[] = [];
  let responseIndex = 0;
  const db = {
    select: vi.fn(() => chain(responses[responseIndex++] ?? [], limitCalls)),
  };
  return { db, limitCalls };
}

describe("integridade das listas de captação", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não deixa a fila de captação parecer completa acima de 120 fichas", async () => {
    const rows = Array.from({ length: 121 }, (_, id) => ({
      capture: { id, presentationStatus: "scheduled", qualificationStatus: "qualified", promoterId: null, captureLocation: null, averageIncome: null, travelWeeksPerYear: null },
      customer: { fullName: `Associado ${id}`, phone: null, city: null },
      campaign: null,
    }));
    const fixture = makeDb([rows]);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = capturesRouter.createCaller({ user: { id: 7, role: "seller" } } as never);

    const result = await caller.list();

    expect(result.rows).toHaveLength(120);
    expect(result.truncated).toBe(true);
    expect(result.truncatedSources).toEqual(["fichas de captação"]);
    expect(fixture.limitCalls).toEqual([121]);
  });

  it("sinaliza cada catálogo de seleção acima de mil linhas", async () => {
    const campaigns = Array.from({ length: 1001 }, (_, id) => ({ id, name: `Campanha ${id}`, code: `C-${id}`, status: "active" }));
    const sellers = Array.from({ length: 1001 }, (_, id) => ({ id, name: `Vendedor ${id}`, role: "seller" }));
    const resorts = Array.from({ length: 1001 }, (_, id) => ({ id, name: `Empreendimento ${id}` }));
    const fixture = makeDb([campaigns, sellers, resorts]);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = capturesRouter.createCaller({ user: { id: 7, role: "service" } } as never);

    const result = await caller.selectors();

    expect(result.campaigns.rows).toHaveLength(1000);
    expect(result.campaigns.truncatedSources).toEqual(["campanhas de captação"]);
    expect(result.sellers.rows).toHaveLength(1000);
    expect(result.sellers.truncatedSources).toEqual(["vendedores de captação"]);
    expect(result.resorts.rows).toHaveLength(1000);
    expect(result.resorts.truncatedSources).toEqual(["empreendimentos de captação"]);
    expect(fixture.limitCalls).toEqual([1001, 1001, 1001]);
  });
});

export {};
