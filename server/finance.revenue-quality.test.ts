import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => ({ ...dbMocks, recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));

import { financeRouter } from "./routers/finance";

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, () => unknown>;
  promise.from = () => promise;
  promise.where = () => promise;
  promise.limit = () => promise;
  return promise;
}

describe("finance.revenueQuality", () => {
  beforeEach(() => vi.clearAllMocks());

  it("projeta contrato, parcelas, comissão e distrato em uma leitura econômica rastreável", async () => {
    const responses = [
      [{ id: 77, number: "TGR-077", totalAmount: "10000.00", status: "cancelled" }],
      [{ id: 701, contractId: 77, sequence: 1, amount: "2000.00", status: "paid" }, { id: 702, contractId: 77, sequence: 2, amount: "8000.00", status: "cancelled" }],
      [{ id: 801, contractId: 77, amount: "200.00", status: "paid", lifecycleStatus: "paid", sourceInstallmentId: 701 }, { id: 802, contractId: 77, amount: "800.00", status: "cancelled", lifecycleStatus: "cancelled", sourceInstallmentId: 702 }],
      [{ id: 901, contractId: 77, status: "executed", createdAt: new Date("2026-08-21T12:00:00Z") }],
    ];
    dbMocks.getDb.mockResolvedValue({ select: vi.fn(() => chain(responses.shift() ?? [])) });
    const caller = financeRouter.createCaller({ user: { id: 9, role: "finance" } } as never);

    const [projection] = await caller.revenueQuality({ contractId: 77 });

    expect(projection).toMatchObject({
      contractId: 77,
      contractNumber: "TGR-077",
      policyVersion: "tgr-derived-ledger/v1",
      summary: { vgvFormalized: 10000, vgvLiquidRealized: 0, cashConfirmed: 2000, commissionPaid: 200, commissionReversed: 800 },
    });
    expect(projection?.facts).toContainEqual(expect.objectContaining({ type: "revenue_reversed", source: "contract" }));
    expect(projection?.facts).toContainEqual(expect.objectContaining({ type: "commission_reversed", commissionId: 802 }));
  });
});
