import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

// ADR-010: fila manual de estorno (decisão obrigatória) e reprocesso da janela de 0%.
const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const svcMocks = vi.hoisted(() => ({ reprocessSkippedCommissions: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./revenueQualitySync", () => ({ syncRevenueQualityForContract: vi.fn(async () => undefined) }));
vi.mock("./saleValidationService", async importOriginal => ({ ...(await importOriginal<typeof import("./saleValidationService")>()), reprocessSkippedCommissions: svcMocks.reprocessSkippedCommissions }));

import { commissionsRouter } from "./routers/commissions";

function makeDb(opts: { commission?: Record<string, unknown> | null; transaction?: unknown[]; affected?: number } = {}) {
  const updates: Record<string, unknown>[] = [];
  const commission = opts.commission === undefined ? { id: 7, contractId: 9, reversalReviewStatus: "pending" } : opts.commission;
  const db = {
    select: () => ({ from: (t: object) => { const name = getTableName(t as never); const rows = name === "sales_commissions" ? (commission ? [commission] : []) : name === "financial_transactions" ? (opts.transaction ?? []) : []; const chain: any = { where: () => chain, limit: () => chain, then: (res: (v: unknown) => void) => res(rows) }; return chain; } }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updates.push(values); return [{ affectedRows: opts.affected ?? 1 }]; } }) }),
  };
  dbMocks.getDb.mockResolvedValue(db);
  return { updates };
}
const as = (role: string) => commissionsRouter.createCaller({ user: { id: 55, role } } as never);

describe("ADR-010 resolveReversalReview: decisão obrigatória", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exige decision (reversed|offset|waived) e nota", async () => {
    makeDb();
    await expect((as("finance") as any).resolveReversalReview({ id: 7, note: "feito pelo financeiro" })).rejects.toThrow();
    await expect((as("finance") as any).resolveReversalReview({ id: 7, decision: "ignorar", note: "feito pelo financeiro" })).rejects.toThrow();
    await expect(as("finance").resolveReversalReview({ id: 7, decision: "waived", note: "abc" })).rejects.toThrow();
  });

  it.each(["reversed", "offset", "waived"] as const)("%s: grava decisão, audita e emite commission.reversal_review.resolved", async decision => {
    const { updates } = makeDb();
    await expect(as("finance").resolveReversalReview({ id: 7, decision, note: "Conferido com o financeiro" })).resolves.toEqual({ success: true });
    expect(updates[0]).toMatchObject({ reversalReviewStatus: "resolved", reversalReviewDecision: decision, reversalReviewFinancialTransactionId: null, reversalReviewResolvedByUserId: 55, reversalReviewNote: "Conferido com o financeiro" });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_commission", 7, "reversal_review_resolved", expect.stringContaining(decision));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith({ eventName: "commission.reversal_review.resolved", aggregateType: "sales_commission", aggregateId: 7, actorUserId: 55, payload: { contractId: 9, commissionId: 7, decision, financialTransactionId: null }, idempotencyKey: "commission-reversal-review-resolved:7" });
  });

  it("lançamento financeiro opcional: grava o vínculo quando existe e recusa quando não existe", async () => {
    const ok = makeDb({ transaction: [{ id: 33 }] });
    await as("admin").resolveReversalReview({ id: 7, decision: "offset", financialTransactionId: 33, note: "Compensado no lançamento 33" });
    expect(ok.updates[0]).toMatchObject({ reversalReviewDecision: "offset", reversalReviewFinancialTransactionId: 33 });
    vi.clearAllMocks();
    const missing = makeDb({ transaction: [] });
    await expect(as("admin").resolveReversalReview({ id: 7, decision: "offset", financialTransactionId: 999, note: "Compensado no lançamento 999" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(missing.updates).toHaveLength(0);
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("não resolve duas vezes nem comissão inexistente; sem evento nem auditoria nesses casos", async () => {
    makeDb({ commission: { id: 7, contractId: 9, reversalReviewStatus: "resolved" } });
    await expect(as("finance").resolveReversalReview({ id: 7, decision: "waived", note: "Segunda tentativa" })).rejects.toMatchObject({ code: "CONFLICT" });
    makeDb({ commission: null });
    await expect(as("finance").resolveReversalReview({ id: 8, decision: "waived", note: "Não existe" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    makeDb({ affected: 0 });
    await expect(as("finance").resolveReversalReview({ id: 7, decision: "waived", note: "Corrida perdida" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("papéis sem commission.pay (seller/service) não acessam fila nem resolvem", async () => {
    makeDb();
    await expect(as("seller").reversalQueue()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("seller").resolveReversalReview({ id: 7, decision: "waived", note: "tentativa de vendedor" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("service").resolveReversalReview({ id: 7, decision: "waived", note: "tentativa de atendimento" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("ADR-010 reprocessSkipped", () => {
  beforeEach(() => vi.clearAllMocks());
  it("exige contractId ou resortId e só papéis com commission.pay", async () => {
    makeDb();
    await expect(as("finance").reprocessSkipped({})).rejects.toThrow();
    await expect(as("seller").reprocessSkipped({ contractId: 9 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(svcMocks.reprocessSkippedCommissions).not.toHaveBeenCalled();
  });
  it("delega ao serviço com o ator e audita a execução", async () => {
    makeDb();
    svcMocks.reprocessSkippedCommissions.mockResolvedValue({ candidates: 2, created: 2, stillZeroRate: 0, ineligible: 0, alreadyCommissioned: 0, truncated: false, createdInstallmentIds: [91] });
    await expect(as("admin").reprocessSkipped({ resortId: 3 })).resolves.toMatchObject({ created: 2 });
    expect(svcMocks.reprocessSkippedCommissions).toHaveBeenCalledWith(expect.anything(), { contractId: undefined, resortId: 3, actorUserId: 55 });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "resort", 3, "commission_skipped_reprocess_run", expect.stringContaining("2 comissão"));
  });
});
