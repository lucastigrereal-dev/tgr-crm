import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";
import { COOKIE_NAME } from "../shared/const";

const dbMocks = vi.hoisted(() => ({ getUserByOpenId: vi.fn(), upsertUser: vi.fn() }));
vi.mock("./db", () => dbMocks);
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sdk } from "./_core/sdk";

const user: User = {
  id: 7,
  openId: "user-7",
  name: "Usuário de teste",
  email: "user-7@example.com",
  loginMethod: "test",
  role: "user",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
};

describe("confiabilidade da sessão", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(sdk, "verifySession").mockResolvedValue({ openId: "user-7", appId: "test-app", name: "Usuário de teste" });
    dbMocks.getUserByOpenId.mockResolvedValue(user);
  });

  it("mantém a sessão válida quando a atualização de lastSignedIn falha", async () => {
    dbMocks.upsertUser.mockRejectedValue(new Error("database temporarily unavailable"));

    const authenticated = await sdk.authenticateRequest({ headers: { cookie: `${COOKIE_NAME}=valid-session` } } as never);

    expect(authenticated).toEqual(user);
    expect(dbMocks.getUserByOpenId).toHaveBeenCalledWith("user-7");
    expect(dbMocks.upsertUser).toHaveBeenCalledWith(expect.objectContaining({ openId: "user-7", lastSignedIn: expect.any(Date) }));
  });
});
