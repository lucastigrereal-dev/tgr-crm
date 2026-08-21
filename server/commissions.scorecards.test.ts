import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { commissionsRouter } from "./routers/commissions";

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, () => unknown>;
  promise.from = () => promise;
  promise.where = () => promise;
  return promise;
}

describe("commissions.scorecards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("atribui FTB uma vez e reconhece entrada confirmada a partir das fontes transacionais", async () => {
    const responses = [
      [{ id: 20, proposalId: 10, totalAmount: "12000.00", status: "active" }],
      [{ id: 10, opportunityId: 5 }],
      [{ id: 5 }],
      [{ id: 100, opportunityId: 5, promoterId: 2, qualifierId: 3, linerId: 7, closerId: 7, roomManagerId: 4, createdAt: new Date("2026-08-21T12:00:00Z") }],
      [{ id: 300, contractId: 20, amount: "2400.00", status: "paid" }],
      [],
      [{ id: 2, name: "Paula Captação", email: "paula@tgr.local" }, { id: 3, name: "Queli Qualificação", email: "queli@tgr.local" }, { id: 4, name: "Gerson Gerente", email: "gerson@tgr.local" }, { id: 7, name: "Leo Front Back", email: "leo@tgr.local" }],
    ];
    dbMocks.getDb.mockResolvedValue({ select: vi.fn(() => chain(responses.shift() ?? [])) });
    const caller = commissionsRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    const result = await caller.scorecards({ minimumMaturedSales: 1 });

    expect(result.rolesCovered).toEqual(["promoter", "qualifier", "liner", "closer", "ftb", "room_manager"]);
    expect(result.scorecards).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 2, userName: "Paula Captação", role: "promoter", attributedSales: 1, cashConfirmed: 2400, coverage: "mature" }),
      expect.objectContaining({ userId: 3, userName: "Queli Qualificação", role: "qualifier", attributedSales: 1, cashConfirmed: 2400 }),
      expect.objectContaining({ userId: 4, userName: "Gerson Gerente", role: "room_manager", attributedSales: 1, cashConfirmed: 2400 }),
      expect.objectContaining({ userId: 7, userName: "Leo Front Back", role: "ftb", attributedSales: 1, vgvFormalized: 12000, cashConfirmed: 2400 }),
    ]));
    expect(result.scorecards).not.toEqual(expect.arrayContaining([expect.objectContaining({ userId: 7, role: "liner" }), expect.objectContaining({ userId: 7, role: "closer" })]));
  });
});
