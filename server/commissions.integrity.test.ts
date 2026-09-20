import { beforeEach, describe, expect, it, vi } from "vitest";
import { salesCommissions } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { commissionsRouter } from "./routers/commissions";

function makeDb(rows: unknown[], affectedRows = 1) {
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      if (table !== salesCommissions) throw new Error("Tabela não prevista neste teste");
      return { where: vi.fn(() => ({ limit: vi.fn(async () => rows) })) };
    }),
  }));
  const sets: unknown[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((value: unknown) => { sets.push(value); return { where: vi.fn(async () => ({ affectedRows })) }; }),
  }));
  return { db: { select, update }, update, sets };
}

function caller() {
  return commissionsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

describe("integridade do status de comissão", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita comissão inexistente sem atualizar ou auditar", async () => {
    const fixture = makeDb([]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita corrida perdida sem auditar alteração falsa", async () => {
    const fixture = makeDb([{ contractId: null, status: "pending" }], 0);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("atualiza comissão existente e audita uma única vez", async () => {
    const fixture = makeDb([{ contractId: null, status: "pending" }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).resolves.toEqual({ success: true });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "sales_commission", 901, "approved", "Comissão marcada como approved.");
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith({ eventName: "commission.status.updated", aggregateType: "sales_commission", aggregateId: 901, actorUserId: 55, payload: { status: "approved", contractId: null } });
  });

  it("sincroniza lifecycle e datas quando a comissão é paga", async () => {
    const fixture = makeDb([{ contractId: null, status: "approved" }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "paid" })).resolves.toEqual({ success: true });
    expect(fixture.sets[0]).toMatchObject({ status: "paid", lifecycleStatus: "paid", paidAt: expect.any(Date), receivedAt: expect.any(Date) });
    expect((fixture.sets[0] as { paidAt: Date }).paidAt).toEqual((fixture.sets[0] as { receivedAt: Date }).receivedAt);
  });

  it("sincroniza lifecycle e data quando a comissão é cancelada", async () => {
    const fixture = makeDb([{ contractId: null, status: "approved" }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "cancelled" })).resolves.toEqual({ success: true });
    expect(fixture.sets[0]).toMatchObject({ status: "cancelled", lifecycleStatus: "cancelled", cancelledAt: expect.any(Date) });
  });

  it("torna retry do mesmo status um no-op sem repetir trilha", async () => {
    const fixture = makeDb([{ contractId: null, status: "approved" }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: "approved" })).resolves.toEqual({ success: true });
    expect(fixture.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });

  it.each([
    { current: "paid" as const, next: "approved" as const },
    { current: "cancelled" as const, next: "paid" as const },
  ])("bloqueia reabertura de comissão $current para $next", async ({ current, next }) => {
    const fixture = makeDb([{ contractId: null, status: current }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().setStatus({ id: 901, status: next })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
    expect(dbMocks.recordDomainEvent).not.toHaveBeenCalled();
  });
});

