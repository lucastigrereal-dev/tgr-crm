import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function makeDb(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    limit: vi.fn(async () => rows),
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain) };
}

describe("integridade do DRE por campanha", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca DRE parcial quando a consulta agregada ultrapassa o teto de grupos", async () => {
    const rows = Array.from({ length: 1_001 }, (_, campaignId) => ({
      campaignId,
      campaignName: `Campanha ${campaignId}`,
      type: "income",
      amount: "100.00",
    }));
    const db = makeDb(rows);
    dbMocks.getDb.mockResolvedValue(db);
    const caller = financeRouter.createCaller({ user: { id: 5, role: "finance" } } as never);

    await expect(caller.dreByCampaign()).resolves.toMatchObject({
      rows: expect.any(Array),
      truncated: true,
      truncatedSources: ["grupos do DRE"],
    });
    expect(db.select.mock.results[0]?.value.limit).toHaveBeenCalledWith(1_001);
  });
});

export {};

