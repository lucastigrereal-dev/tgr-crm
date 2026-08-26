import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { financeRouter } from "./routers/finance";

function databaseFor(entry: { id: number; status: "open" | "paid" | "cancelled"; reconciledAt?: Date | null }, affectedRows = 1) {
  const updates: unknown[] = [];
  return {
    updates,
    db: {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [entry] }) }) })),
      update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); return { affectedRows }; }) })) })),
    },
  };
}

describe("conciliação financeira", () => {
  beforeEach(() => vi.clearAllMocks());

  it("concilia lançamento pago com referência, auditoria e evento de domínio", async () => {
    const fixture = databaseFor({ id: 81, status: "paid" }); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = financeRouter.createCaller({ user: { id: 5, role: "finance" } } as never);

    await expect(caller.reconcileEntry({ id: 81, reconciliationReference: "OFX-2026-00081" })).resolves.toEqual({ success: true });
    expect(fixture.updates[0]).toMatchObject({ reconciliationReference: "OFX-2026-00081", reconciledAt: expect.any(Date), reconciledByUserId: 5 });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(5, "financial_transaction", 81, "reconciled", expect.stringContaining("OFX-2026-00081"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "financial.entry.reconciled", aggregateId: 81, actorUserId: 5, payload: { reference: "OFX-2026-00081", reconciledAt: expect.any(Date) } }));
  });

  it("recusa conciliar lançamento que ainda não foi pago", async () => {
    const fixture = databaseFor({ id: 82, status: "open" }); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = financeRouter.createCaller({ user: { id: 5, role: "finance" } } as never);

    await expect(caller.reconcileEntry({ id: 82, reconciliationReference: "OFX-2026-00082" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.updates).toHaveLength(0);
  });

  it("não escreve novamente um lançamento já conciliado", async () => {
    const fixture = databaseFor({ id: 83, status: "paid", reconciledAt: new Date("2026-08-25T12:00:00Z") }); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = financeRouter.createCaller({ user: { id: 5, role: "finance" } } as never);

    await expect(caller.reconcileEntry({ id: 83, reconciliationReference: "OFX-REPETIDO" })).resolves.toEqual({ success: true, alreadyReconciled: true });
    expect(fixture.updates).toHaveLength(0);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("não audita quando outra conciliação vence a corrida", async () => {
    const fixture = databaseFor({ id: 84, status: "paid" }, 0); dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = financeRouter.createCaller({ user: { id: 5, role: "finance" } } as never);

    await expect(caller.reconcileEntry({ id: 84, reconciliationReference: "OFX-CORRIDA" })).resolves.toEqual({ success: true, alreadyReconciled: true });
    expect(fixture.updates).toHaveLength(1);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });
});
