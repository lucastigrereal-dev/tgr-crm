import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({
  upsertUser: vi.fn(),
  getUserByOpenId: vi.fn(),
}));
vi.mock("./db", () => dbMocks);

import {
  LocalAuthError,
  authenticateLocalUser,
  hashLocalPassword,
  localAuthStatus,
  resetLocalAuthAttemptsForTests,
  verifyLocalPassword,
} from "./localAuth";

const salt = "00112233445566778899aabbccddeeff";
const password = "Senha-Piloto-Forte-2026!";

const admin: User = {
  id: 1,
  openId: "local:lucas.admin",
  name: "Lucas Admin",
  email: null,
  loginMethod: "local",
  role: "admin",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
};
describe("local auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("LOCAL_AUTH_ENABLED", "1");
    vi.stubEnv("LOCAL_AUTH_USERNAME", "lucas.admin");
    vi.stubEnv("LOCAL_AUTH_PASSWORD_HASH", hashLocalPassword(password, salt));
    vi.stubEnv("LOCAL_AUTH_DISPLAY_NAME", "Lucas Admin");
    resetLocalAuthAttemptsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetLocalAuthAttemptsForTests();
  });

  it("gera e valida hash scrypt sem armazenar a senha", () => {
    const encoded = hashLocalPassword(password, salt);
    expect(encoded).not.toContain(password);
    expect(verifyLocalPassword(password, encoded)).toBe(true);
    expect(verifyLocalPassword("senha-errada-123456", encoded)).toBe(false);
  });

  it("informa se o login local está configurado", () => {
    expect(localAuthStatus()).toEqual({ enabled: true });
    vi.stubEnv("LOCAL_AUTH_PASSWORD_HASH", "");
    expect(localAuthStatus()).toEqual({ enabled: false });
  });
  it("autentica, provisiona admin e retorna o usuário persistido", async () => {
    dbMocks.getUserByOpenId.mockResolvedValue(admin);

    const result = await authenticateLocalUser(
      { username: "lucas.admin", password },
      "127.0.0.1",
      Date.parse("2026-09-19T23:00:00Z"),
    );

    expect(result).toEqual(admin);
    expect(dbMocks.upsertUser).toHaveBeenCalledWith(expect.objectContaining({
      openId: "local:lucas.admin",
      name: "Lucas Admin",
      loginMethod: "local",
      role: "admin",
    }));
  });

  it("limita tentativas repetidas dentro da mesma janela", async () => {
    for (let index = 0; index < 5; index++) {
      await expect(authenticateLocalUser(
        { username: "lucas.admin", password: "Senha-Errada-123456!" },
        "10.0.0.8",
        1_000,
      )).rejects.toMatchObject({ code: "INVALID" });
    }
    await expect(authenticateLocalUser(
      { username: "lucas.admin", password },
      "10.0.0.8",
      1_001,
    )).rejects.toMatchObject({ code: "LOCKED" });
  });

  it("recusa login quando o recurso está desabilitado", async () => {
    vi.stubEnv("LOCAL_AUTH_ENABLED", "0");
    await expect(authenticateLocalUser(
      { username: "lucas.admin", password },
      "127.0.0.1",
    )).rejects.toBeInstanceOf(LocalAuthError);
  });
});
