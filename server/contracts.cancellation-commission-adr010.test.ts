import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./revenueQualitySync", () => ({ syncRevenueQualityForContract: vi.fn(async () => undefined) }));

import { contractsRouter } from "./routers/contracts";

// tx mock: seleciona por nome de tabela; registra os updates em sales_commissions.
function makeDb() {
  const commissionUpdates: Record<string, unknown>[] = [];
  const rowsFor = (table: string): unknown[] => {
    if (table === "contract_cancellation_requests") return [{ id: 5, contractId: 9, status: "approved", reason: "x", decisionNotes: null, simulationSnapshot: JSON.stringify({ paidAmount: 0 }) }];
    if (table === "contracts") return [{ id: 9, status: "active" }];
    if (table === "sales_commissions") return [{ id: 1, status: "pending" }, { id: 2, status: "paid" }];
    return [];
  };
  const tx = {
    select: () => ({ from: (t: object) => { const name = getTableName(t as never); const chain: any = { where: () => chain, limit: () => chain, for: () => chain, then: (res: (v: unknown) => void) => res(rowsFor(name)) }; return chain; } }),
    update: (t: object) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { if (getTableName(t as never) === "sales_commissions") commissionUpdates.push(values); return [{ affectedRows: 1 }]; } }) }),
    insert: () => ({ values: () => ({ $returningId: async () => [] }) }),
  };
  return { commissionUpdates, db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
}

describe("ADR-010 distrato: comissão", () => {
  beforeEach(() => vi.clearAllMocks());
  it("cancela a não paga; a paga vai para fila manual pendente e é auditada (sem estorno)", async () => {
    const { db, commissionUpdates } = makeDb();
    dbMocks.getDb.mockResolvedValue(db);
    await contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never).executeCancellation({ requestId: 5 });
    expect(commissionUpdates.find(v => v.status === "cancelled")).toBeTruthy();
    const review = commissionUpdates.find(v => v.reversalReviewStatus === "pending");
    expect(review).toBeTruthy();
    expect(review).not.toHaveProperty("status");
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_commission", 2, "reversal_review_pending", expect.stringContaining("fila manual"));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_commission", 1, "cancelled", expect.any(String));
  });
});
