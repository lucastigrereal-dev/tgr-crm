import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-007 (V6): comissão automática só nasce com venda VALIDADA (contrato active + sale_validations.validatedAt).
const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./revenueQualitySync", () => ({ syncRevenueQualityForContract: vi.fn(async () => ({})) }));

import { salesCommissions } from "../drizzle/schema";
import { financeRouter } from "./routers/finance";

function query(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, ReturnType<typeof vi.fn>>;
  for (const key of ["from", "where", "orderBy", "limit", "for"]) promise[key] = vi.fn(() => promise);
  return promise;
}
const completePolicy = JSON.stringify({ linerRate: 0.02, closerRate: 0.03, ftbRate: 0.04, cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt" });

function scenario(contractStatus: string, validation: Array<{ validatedAt: Date | null }>) {
  const inserted: Array<{ table: unknown; values: unknown }> = [];
  const tx = {
    select: vi.fn().mockReturnValueOnce(query([{ id: 91, status: "open", amount: "1000.00", paidAmount: "0.00" }])).mockReturnValue(query([])),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })) })),
    insert: vi.fn((table: unknown) => ({ values: vi.fn((values: unknown) => { inserted.push({ table, values }); return { $returningId: async () => (Array.isArray(values) ? values : [values]).map((_, index) => ({ id: 500 + index })) }; }) })),
  };
  const db = {
    select: vi.fn()
      .mockReturnValueOnce(query([{ id: 91, contractId: 61, sequence: 2, amount: "1000.00", paidAmount: "0.00", dueDate: new Date("2026-09-10T12:00:00Z"), status: "open" }]))
      .mockReturnValueOnce(query([{ id: 61, proposalId: 41, totalAmount: "10000.00", status: contractStatus }]))
      .mockReturnValueOnce(query([{ id: 41, opportunityId: 51, downPaymentAmount: "1000.00" }]))
      .mockReturnValueOnce(query([{ id: 51 }]))
      .mockReturnValueOnce(query([{ id: 100, opportunityId: 51, resortId: 2, campaignId: 8, linerId: 10, closerId: 11 }]))
      .mockReturnValueOnce(query(validation))
      .mockReturnValueOnce(query([{ commissionPolicy: completePolicy }])),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  dbMocks.getDb.mockResolvedValue(db);
  return { inserted, caller: financeRouter.createCaller({ user: { id: 71, role: "admin" } } as never) };
}
const commissionInserts = (inserted: Array<{ table: unknown }>) => inserted.filter(entry => entry.table === salesCommissions);

describe("comissão automática exige venda validada (baixa manual)", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["VENDEU / contrato gerado (pending_signature), sem validação", "pending_signature", []],
    ["pagamento confirmado mas sem validação final (pending_signature)", "pending_signature", [{ validatedAt: null }]],
    ["contrato active legado sem sale_validations", "active", []],
    ["contrato active com linha sem validatedAt", "active", [{ validatedAt: null }]],
  ] as const)("%s: comissão bloqueada, nada lançado", async (_label, status, validation) => {
    const { inserted, caller } = scenario(status, [...validation]);
    await expect(caller.markInstallmentPaid({ id: 91, paymentMethod: "pix" })).resolves.toEqual({ success: true, alreadyPaid: false, commissionBlocked: true });
    expect(commissionInserts(inserted)).toHaveLength(0);
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.automatic.blocked" }));
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.created" }));
  });

  it("contrato active + venda validada + política completa: comissão é lançada", async () => {
    const { inserted, caller } = scenario("active", [{ validatedAt: new Date("2026-10-06T12:00:00Z") }]);
    await expect(caller.markInstallmentPaid({ id: 91, paymentMethod: "pix" })).resolves.toEqual({ success: true, alreadyPaid: false, commissionBlocked: false });
    expect(commissionInserts(inserted).length).toBeGreaterThan(0);
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.created" }));
  });
});
