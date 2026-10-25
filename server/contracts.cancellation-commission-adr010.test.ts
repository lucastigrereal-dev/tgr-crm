import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./revenueQualitySync", () => ({ syncRevenueQualityForContract: vi.fn(async () => undefined) }));

import { auditLogs, domainEvents } from "../drizzle/schema";
import { contractsRouter } from "./routers/contracts";

// tx mock: seleciona por nome de tabela; registra os updates em sales_commissions.
function makeDb() {
  const commissionUpdates: Record<string, unknown>[] = [];
  const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const rowsFor = (table: string): unknown[] => {
    if (table === "contract_cancellation_requests") return [{ id: 5, contractId: 9, status: "approved", reason: "x", decisionNotes: null, simulationSnapshot: JSON.stringify({ paidAmount: 0 }) }];
    if (table === "contracts") return [{ id: 9, status: "active" }];
    if (table === "sales_commissions") return [{ id: 1, status: "pending" }, { id: 2, status: "paid" }];
    return [];
  };
  const tx = {
    select: () => ({ from: (t: object) => { const name = getTableName(t as never); const chain: any = { where: () => chain, limit: () => chain, for: () => chain, leftJoin: () => chain, orderBy: () => chain, then: (res: (v: unknown) => void) => res(rowsFor(name)) }; return chain; } }),
    update: (t: object) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { if (getTableName(t as never) === "sales_commissions") commissionUpdates.push(values); return [{ affectedRows: 1 }]; } }) }),
    insert: (t: unknown) => ({ values: (values: Record<string, unknown>) => { inserted.push({ table: t, values }); return { $returningId: async () => [], onDuplicateKeyUpdate: async () => undefined }; } }),
  };
  // Issue #43 (distrato): auditoria e eventos nascem na transação (tx.insert em audit_logs/domain_events).
  const audits = () => inserted.filter(entry => entry.table === auditLogs).map(entry => entry.values);
  const events = () => inserted.filter(entry => entry.table === domainEvents).map(entry => ({ ...entry.values, payload: JSON.parse(entry.values.payload as string) as unknown }));
  return { commissionUpdates, audits, events, db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
}

describe("ADR-010 distrato: comissão", () => {
  beforeEach(() => vi.clearAllMocks());
  it("cancela a não paga; a paga vai para fila manual pendente e é auditada (sem estorno)", async () => {
    const { db, commissionUpdates, audits } = makeDb();
    dbMocks.getDb.mockResolvedValue(db);
    await contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never).executeCancellation({ requestId: 5 });
    expect(commissionUpdates.find(v => v.status === "cancelled")).toBeTruthy();
    const review = commissionUpdates.find(v => v.reversalReviewStatus === "pending");
    expect(review).toBeTruthy();
    expect(review).not.toHaveProperty("status");
    expect(audits()).toContainEqual(expect.objectContaining({ actorUserId: 55, entityType: "sales_commission", entityId: "2", action: "reversal_review_pending", summary: expect.stringContaining("fila manual") }));
    expect(audits()).toContainEqual(expect.objectContaining({ actorUserId: 55, entityType: "sales_commission", entityId: "1", action: "cancelled" }));
  });

  it("emite commission.reversal_review.requested (idempotente) para cada comissão paga enfileirada, só interno", async () => {
    const { db, events } = makeDb();
    dbMocks.getDb.mockResolvedValue(db);
    await contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never).executeCancellation({ requestId: 5 });
    expect(events()).toContainEqual({ eventName: "commission.reversal_review.requested", aggregateType: "sales_commission", aggregateId: "2", actorUserId: 55, payload: { contractId: 9, commissionId: 2, distratoRequestId: 5 }, idempotencyKey: "commission-reversal-review-requested:2" });
    expect(events().filter(event => event.eventName === "commission.reversal_review.requested")).toHaveLength(1);
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });
});
