import { beforeEach, describe, expect, it, vi } from "vitest";
import { contracts, customers, users } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { operationsRouter } from "./routers/operations";

function makeDb(options: { customerRows?: unknown[]; contractRows?: unknown[]; assigneeRows?: unknown[] } = {}) {
  const inserted: unknown[] = [];
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => table === customers ? (options.customerRows ?? [{ id: 3 }]) : table === contracts ? (options.contractRows ?? [{ id: 8, customerId: 3 }]) : table === users ? (options.assigneeRows ?? [{ id: 12 }]) : [],
      }),
    }),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((value: unknown) => {
      inserted.push(value);
      return { $returningId: async () => [{ id: 901 }] };
    }),
  }));
  return { db: { select, insert }, inserted };
}

describe("integridade referencial de tarefas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bloqueia cliente inexistente antes do insert", async () => {
    const fixture = makeDb({ customerRows: [] });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.createTask({ title: "Retornar cliente", customerId: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.inserted).toEqual([]);
  });

  it("bloqueia contrato inexistente e vínculo cliente-contrato incorreto", async () => {
    const missingContract = makeDb({ contractRows: [] });
    dbMocks.getDb.mockResolvedValue(missingContract.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);
    await expect(caller.createTask({ title: "Cobrar parcela", customerId: 3, contractId: 8 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(missingContract.inserted).toEqual([]);

    const mismatchedContract = makeDb({ contractRows: [{ id: 8, customerId: 99 }] });
    dbMocks.getDb.mockResolvedValue(mismatchedContract.db);
    await expect(caller.createTask({ title: "Cobrar parcela", customerId: 3, contractId: 8 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mismatchedContract.inserted).toEqual([]);
  });

  it("rejeita lembrete posterior ao vencimento antes do insert", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.createTask({ title: "Cobrar cliente", dueAt: "2026-08-25T10:00:00.000Z", reminderAt: "2026-08-25T11:00:00.000Z" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.inserted).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("grava tarefa somente quando todas as referências são válidas", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.createTask({ title: "Retornar cliente", customerId: 3, contractId: 8 })).resolves.toEqual({ id: 901 });
    expect(fixture.inserted[0]).toMatchObject({ title: "Retornar cliente", customerId: 3, contractId: 8, assignedToUserId: 12, createdByUserId: 12 });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(12, "task", 901, "created", expect.stringContaining("Retornar cliente"));
  });
});

