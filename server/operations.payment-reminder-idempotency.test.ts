import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { contracts, installments, tasks } from "../drizzle/schema";
import { operationsRouter } from "./routers/operations";

function query(rows: unknown[], limitCalls: number[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async (value: number) => {
      limitCalls.push(value);
      return rows;
    }),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

describe("idempotência de lembrete automático de cobrança", () => {
  beforeEach(() => vi.clearAllMocks());

  it("insere lembrete com chave determinística e no-op em duplicata", async () => {
    const dueDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const inserted: unknown[] = [];
    const limitCalls: number[] = [];
    const onDuplicateKeyUpdate = vi.fn(async () => undefined);
    const db = {
      select: vi.fn((selection?: unknown) => ({
        from: (table: unknown) => table === installments ? query([{ installment: { id: 91, contractId: 61, sequence: 1, dueDate, status: "open" }, customerId: 7 }], limitCalls) : table === contracts ? query([], limitCalls) : query([], limitCalls),
      })),
      insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { inserted.push(value); return { onDuplicateKeyUpdate }; }) })),
    };
    dbMocks.getDb.mockResolvedValue(db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.tasks()).resolves.toMatchObject({ rows: [], truncated: false, truncatedSources: [] });

    expect(inserted[0]).toMatchObject({ type: "payment", contractId: 61, customerId: 7, automationKey: expect.stringContaining("61:") });
    expect(inserted[0]).toMatchObject({ automationKey: expect.stringContaining("#1") });
    expect(onDuplicateKeyUpdate).toHaveBeenCalledTimes(1);
    expect(limitCalls).toEqual([5001, 5001, 201]);
  });
});

void tasks;

