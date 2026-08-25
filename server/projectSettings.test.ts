import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./db", () => dbMocks);

import { projectSettingsRouter } from "./routers/projectSettings";

const caller = projectSettingsRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

describe("project settings input", () => {
  it("rejeita JSON inválido antes de tocar o banco", async () => {
    await expect(caller.upsert({ resortId: 1, cancellationPolicy: "{invalido" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMocks.getDb).not.toHaveBeenCalled();
  });
});
