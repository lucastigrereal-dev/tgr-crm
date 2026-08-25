import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { projectSettingsRouter } from "./routers/projectSettings";

function makeDb({ resortExists = true, currentExists = false, affectedRows }: { resortExists?: boolean; currentExists?: boolean; affectedRows?: number } = {}) {
  let selectCall = 0;
  const select = vi.fn(() => {
    const rows = selectCall++ === 0 ? (resortExists ? [{ id: 1 }] : []) : (currentExists ? [{ id: 5, resortId: 1 }] : []);
    const result = Promise.resolve(rows);
    const limitChain = { for: vi.fn(async () => result), then: result.then.bind(result) };
    const chain = { from: vi.fn(() => chain), where: vi.fn(() => chain), limit: vi.fn(() => limitChain) };
    return chain;
  });
  const insertedValues: unknown[] = [];
  const insert = vi.fn(() => ({ values: vi.fn(async (value: unknown) => { insertedValues.push(value); }) }));
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => affectedRows === undefined ? undefined : { affectedRows }) })) }));
  const transaction = vi.fn(async (callback: (tx: { select: typeof select; insert: typeof insert; update: typeof update }) => Promise<unknown>) => callback({ select, insert, update }));
  return { db: { select, insert, update, transaction }, insert, update, insertedValues };
}

describe("project settings input", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejeita JSON inválido antes de tocar o banco", async () => {
    const caller = projectSettingsRouter.createCaller({ user: { id: 1, role: "admin" } } as never);
    await expect(caller.upsert({ resortId: 1, cancellationPolicy: "{invalido" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMocks.getDb).not.toHaveBeenCalled();
  });

  it("rejeita empreendimento inexistente antes do upsert", async () => {
    const fixture = makeDb({ resortExists: false });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = projectSettingsRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    await expect(caller.upsert({ resortId: 99 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("cria configuração válida dentro da transação e audita uma vez", async () => {
    const fixture = makeDb();
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = projectSettingsRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    await expect(caller.upsert({ resortId: 1, commercialRoles: "{\"closer\":true}" })).resolves.toEqual({ success: true });
    expect(fixture.insertedValues[0]).toEqual(expect.objectContaining({ resortId: 1, updatedByUserId: 1, commercialRoles: "{\"closer\":true}" }));
    expect(dbMocks.recordAudit).toHaveBeenCalledWith(1, "commercial_project_settings", 1, "created", expect.any(String));
  });

  it("não audita atualização que perdeu a corrida", async () => {
    const fixture = makeDb({ currentExists: true, affectedRows: 0 });
    dbMocks.getDb.mockResolvedValue(fixture.db);
    const caller = projectSettingsRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    await expect(caller.upsert({ resortId: 1, commissionPolicy: "{}" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.update).toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });
});
