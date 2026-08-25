import { beforeEach, describe, expect, it, vi } from "vitest";
import { contracts, customers, opportunities, proposals, users } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { contractsRouter } from "./routers/contracts";

function makeDb({ opportunityCustomerId = 99, opportunityMissing = false }: { opportunityCustomerId?: number; opportunityMissing?: boolean } = {}) {
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          if (table === contracts) return [];
          if (table === customers) return [{ id: 10 }];
          if (table === users) return [{ id: 20 }];
          if (table === proposals) return [{ id: 5, opportunityId: 9 }];
          if (table === opportunities) return opportunityMissing ? [] : [{ customerId: opportunityCustomerId }];
          return [];
        }),
      })),
    })),
  }));
  const transaction = vi.fn();
  const insert = vi.fn();
  return { db: { select, transaction, insert }, insert, transaction };
}

const input = { number: "CTR-2026-001", customerId: 10, proposalId: 5, sellerId: 20, usageModel: "points" as const, status: "draft" as const, totalAmount: 12000, firstDueDate: "2026-09-10", installmentCount: 12, notes: null };

function caller() {
  return contractsRouter.createCaller({ user: { id: 20, role: "admin" } } as never);
}

describe("integridade da proposta ao criar contrato", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita proposta vinculada a outro cliente antes de criar contrato", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().create(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita proposta cuja oportunidade não existe", async () => {
    const fixture = makeDb({ opportunityMissing: true });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().create(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});

