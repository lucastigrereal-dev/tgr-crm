import { beforeEach, describe, expect, it, vi } from "vitest";
import { contractCancellationRequests, contracts, installments } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { contractsRouter } from "./routers/contracts";

function makeDb({ contractExists = true, contractStatus = "active", pendingRequest = false, returningId = 901 }: { contractExists?: boolean; contractStatus?: "active" | "cancelled"; pendingRequest?: boolean; returningId?: number } = {}) {
  let selectCall = 0;
  const inserted: unknown[] = [];
  const contract = { id: 701, status: contractStatus, totalAmount: "12000.00", proposalId: null };
  const rowsForCall = () => {
    const call = selectCall++;
    if (call === 0) return contractExists ? [contract] : [];
    if (call === 1) return pendingRequest ? [{ id: 801 }] : [];
    if (call === 2) return [{ id: 71, amount: "1000.00", status: "paid" }];
    return [];
  };
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      const rows = table === contracts && selectCall === 0 ? rowsForCall() : table === contractCancellationRequests && selectCall === 1 ? rowsForCall() : table === installments && selectCall === 2 ? rowsForCall() : [];
      const result = Promise.resolve(rows);
      const chain: { leftJoin: () => typeof chain; where: () => typeof chain; limit: () => unknown } = {
        leftJoin: () => chain,
        where: () => chain,
        limit: () => table === contracts ? { for: async () => rows, then: result.then.bind(result) } : result,
      };
      return chain;
    }),
  }));
  const insert = vi.fn(() => ({ values: vi.fn((value: unknown) => { inserted.push(value); return { $returningId: async () => returningId ? [{ id: returningId }] : [] }; }) }));
  const tx = { select, insert };
  const db = { transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
  return { db, inserted, select, insert };
}

function caller() {
  return contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never);
}

const input = { contractId: 701, reason: "Cliente solicitou cancelamento documentado" };

describe("integridade da solicitação de distrato", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita contrato inexistente antes de consultar ou inserir pedido", async () => {
    const fixture = makeDb({ contractExists: false });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().requestCancellation(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita contrato já cancelado antes de consultar ou inserir pedido", async () => {
    const fixture = makeDb({ contractStatus: "cancelled" });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().requestCancellation(input)).rejects.toMatchObject({ code: "CONFLICT", message: "Contrato já está cancelado." });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita segunda pendência dentro da transação", async () => {
    const fixture = makeDb({ pendingRequest: true });
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().requestCancellation(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("cria pedido válido e só audita depois do insert", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);

    await expect(caller().requestCancellation(input)).resolves.toMatchObject({ id: 901 });
    expect(fixture.inserted[0]).toMatchObject({ contractId: 701, requestedByUserId: 55 });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(55, "contract_cancellation_request", 901, "requested", expect.stringContaining("701"));
    expect(dbMocks.recordDomainEvent).toHaveBeenCalledWith({ eventName: "contract.cancellation.requested", aggregateType: "contract_cancellation_request", aggregateId: 901, actorUserId: 55, payload: { contractId: 701, paidAmount: 1000 } });
  });
});

