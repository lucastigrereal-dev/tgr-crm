import { beforeEach, describe, expect, it, vi } from "vitest";

// KAN-31 V6 (invariante de comissão): nenhuma comissão vira pagável/paga (approved|paid => commission.status.updated
// paid ao Financial) antes de sale_validations.validatedAt. Cancelar continua livre (distrato, erro de lançamento).
// COMMISSION_POLICY = NOT_APPROVED: nada de percentual/prazo/estorno é inventado aqui.
const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./revenueQualitySync", () => ({ syncRevenueQualityForContract: vi.fn(async () => ({})) }));

import { commissionsRouter } from "./routers/commissions";

function query(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, ReturnType<typeof vi.fn>>;
  for (const key of ["from", "where", "orderBy", "limit", "for"]) promise[key] = vi.fn(() => promise);
  return promise;
}

function scenario(commission: { contractId: number | null; status: string }, validation: Array<{ validatedAt: Date | null }>) {
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })) }));
  const db = { select: vi.fn().mockReturnValueOnce(query([commission])).mockReturnValue(query(validation)), update };
  dbMocks.getDb.mockResolvedValue(db);
  return { update, caller: commissionsRouter.createCaller({ user: { id: 71, role: "finance" } } as never) };
}

describe("commissions.setStatus exige venda validada para approved/paid", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["approved", "contrato sem validação", { contractId: 61, status: "pending" }, []],
    ["paid", "contrato sem validação", { contractId: 61, status: "approved" }, []],
    ["paid", "pagamento confirmado mas sem validação final", { contractId: 61, status: "pending" }, [{ validatedAt: null }]],
    ["paid", "comissão sem contrato", { contractId: null, status: "pending" }, []],
  ] as const)("%s com %s: recusa COMMISSION_REQUIRES_VALIDATED_SALE e não grava nem emite", async (status, _label, commission, validation) => {
    const { update, caller } = scenario({ ...commission }, [...validation]);
    await expect(caller.setStatus({ id: 5, status })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("COMMISSION_REQUIRES_VALIDATED_SALE") });
    expect(update).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it("paid com venda validada: grava e emite commission.status.updated", async () => {
    const { update, caller } = scenario({ contractId: 61, status: "approved" }, [{ validatedAt: new Date("2026-10-06T12:00:00Z") }]);
    await expect(caller.setStatus({ id: 5, status: "paid" })).resolves.toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "commission.status.updated", payload: { status: "paid", contractId: 61 } }));
  });

  it("cancelar não depende de validação", async () => {
    const { update, caller } = scenario({ contractId: 61, status: "pending" }, []);
    await expect(caller.setStatus({ id: 5, status: "cancelled" })).resolves.toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
