import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { teamRouter } from "./routers/team";

function makeDb(userRows: unknown[], affectedRows?: number) {
  const updates: unknown[] = [];
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => userRows) })) })) })),
    update: vi.fn(() => ({ set: vi.fn((value: unknown) => ({ where: vi.fn(async () => { updates.push(value); return affectedRows === undefined ? undefined : { affectedRows }; }) })) })),
  };
  return { db, updates };
}

describe("integridade de alteração de papel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita usuário inexistente sem alterar nem auditar", async () => {
    const fixture = makeDb([]);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = teamRouter.createCaller({ user: { id: 9, role: "admin" } } as never);

    await expect(caller.updateRole({ id: 72, role: "seller" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.updates).toEqual([]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("impede administrador de remover o próprio acesso", async () => {
    const fixture = makeDb([{ id: 9 }]);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = teamRouter.createCaller({ user: { id: 9, role: "admin" } } as never);

    await expect(caller.updateRole({ id: 9, role: "finance" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixture.updates).toEqual([]);
  });

  it("não audita alteração de papel que perdeu a corrida", async () => {
    const fixture = makeDb([{ id: 72 }], 0);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = teamRouter.createCaller({ user: { id: 9, role: "admin" } } as never);

    await expect(caller.updateRole({ id: 72, role: "seller" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.updates).toEqual([{ role: "seller" }]);
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("altera e audita papel válido", async () => {
    const fixture = makeDb([{ id: 72 }], 1);
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = teamRouter.createCaller({ user: { id: 9, role: "admin" } } as never);

    await expect(caller.updateRole({ id: 72, role: "service" })).resolves.toEqual({ success: true });
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(9, "user", 72, "role_updated", expect.stringContaining("service"));
  });
});

