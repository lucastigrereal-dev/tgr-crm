import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { operationsRouter } from "./routers/operations";

function makeDb(status: "open" | "in_progress" | "done" | "cancelled" | null, affectedRows = 1) {
  const updates: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => status ? [{ status }] : []) })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); return { affectedRows }; }) })),
    })),
  };
  return { db, updates };
}

describe("lifecycle de tarefas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita tarefa inexistente sem atualizar nem auditar", async () => {
    const fixture = makeDb(null);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.updateTaskStatus({ id: 999, status: "done" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.db.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("rejeita reabertura de tarefa terminal", async () => {
    const fixture = makeDb("done");
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.updateTaskStatus({ id: 901, status: "open" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.db.update).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("não audita atualização que perdeu a corrida", async () => {
    const fixture = makeDb("open", 0);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.updateTaskStatus({ id: 901, status: "in_progress" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.updates).toHaveLength(1);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("permite transição válida e registra auditoria", async () => {
    const fixture = makeDb("in_progress");
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = operationsRouter.createCaller({ user: { id: 12, role: "service" } } as never);

    await expect(caller.updateTaskStatus({ id: 901, status: "done" })).resolves.toEqual({ success: true });
    expect(fixture.updates[0]).toMatchObject({ status: "done", completedAt: expect.any(Date) });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(12, "task", 901, "status_updated", expect.stringContaining("done"));
  });
});

