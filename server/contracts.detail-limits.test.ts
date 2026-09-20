import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { contractsRouter } from "./routers/contracts";

function makeDb(contract: unknown, schedule: unknown[], documents: unknown[], cancellationRequests: unknown[]) {
  let query = 0;
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async (value: number) => {
      query += 1;
      if (query === 1) {
        expect(value).toBe(1);
        return [contract];
      }
      if (query === 2) {
        expect(value).toBe(361);
        return schedule;
      }
      if (query === 3) {
        expect(value).toBe(101);
        return documents;
      }
      expect(value).toBe(51);
      return cancellationRequests;
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { select: vi.fn(() => chain) };
}

describe("limites do detalhe contratual", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sinaliza parcelas, documentos e distratos além do limite", async () => {
    const contract = { contract: { id: 9, number: "CTR-9", usageModel: "fixed_week", status: "active", totalAmount: "100.00" }, customerName: "Associado", customerEmail: null, customerPhone: null };
    const schedule = Array.from({ length: 361 }, (_, id) => ({ id, sequence: id + 1 }));
    const documents = Array.from({ length: 101 }, (_, id) => ({ id, filename: `doc-${id}.pdf`, signed: false }));
    const cancellationRequests = Array.from({ length: 51 }, (_, id) => ({ id, status: "rejected" }));
    dbMocks.getDb.mockResolvedValue({ ...makeDb(contract, schedule, documents, cancellationRequests) });
    const caller = contractsRouter.createCaller({ user: { id: 8, role: "service" } } as never);

    const result = await caller.detail({ id: 9 });
    expect(result?.installments).toHaveLength(360);
    expect(result?.documents).toHaveLength(100);
    expect(result?.cancellationRequests).toHaveLength(50);
    expect(result?.truncated).toBe(true);
    expect(result?.truncatedSources).toEqual(["parcelas", "documentos", "distratos"]);
  });
});

export {};
