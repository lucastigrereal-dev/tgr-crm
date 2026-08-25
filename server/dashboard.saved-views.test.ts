import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));

import { getDb, recordAudit } from "./db";
import { appRouter } from "./routers";

const mockedGetDb = vi.mocked(getDb);
const mockedRecordAudit = vi.mocked(recordAudit);

function context(userId = 99, role: "admin" | "finance" = "finance"): TrpcContext {
  return { user: { id: userId, openId: `user-${userId}`, email: `user${userId}@test.com`, name: `Usuário ${userId}`, loginMethod: "test", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() }, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: { clearCookie: () => undefined } as TrpcContext["res"] };
}

function fakeDb(rows: Array<{ id: number; createdByUserId: number; visibility: "personal" | "shared"; filtersJson: string }>, insertId: unknown = 71) {
  return {
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => rows, limit: async () => rows.slice(-1) }) }) }),
    insert: () => ({ values: async () => [{ insertId }] }),
    delete: () => ({ where: async () => undefined }),
  };
}

describe("dashboard.savedViews", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejeita criação sem identificador persistido e não audita sucesso falso", async () => {
    mockedGetDb.mockResolvedValue(fakeDb([], null) as never);
    const caller = appRouter.createCaller(context());

    await expect(caller.dashboard.saveView({ name: "View sem ID", visibility: "personal", filters: {} })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(mockedRecordAudit).not.toHaveBeenCalled();
  });

  it("lista recortes pessoais e compartilhados, cria recorte validado e bloqueia exclusão alheia", async () => {
    const rows = [
      { id: 1, name: "Minha sala", scope: "dashboard", createdByUserId: 99, visibility: "personal" as const, filtersJson: JSON.stringify({ salesRoom: "Sala Ouro" }) },
      { id: 2, name: "Risco campanha", scope: "dashboard", createdByUserId: 7, visibility: "shared" as const, filtersJson: JSON.stringify({ campaignId: 3, presentationStatus: "presented" }) },
    ];
    mockedGetDb.mockResolvedValue(fakeDb(rows) as never);
    const caller = appRouter.createCaller(context());
    const listed = await caller.dashboard.savedViews();
    const created = await caller.dashboard.saveView({ name: "Minha coorte", visibility: "personal", filters: { startDate: "2026-08-01", endDate: "2026-08-31", salesRoom: "Sala Ouro" } });
    expect(listed.map(item => item.name)).toEqual(["Minha sala", "Risco campanha"]);
    expect(listed[1]?.filters).toMatchObject({ campaignId: 3, presentationStatus: "presented" });
    expect(created).toEqual({ id: 71 });
    await expect(caller.dashboard.deleteSavedView({ id: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
