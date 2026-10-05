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
  isLocalSessionValid,
  localAuthStatus,
  resetLocalAuthAttemptsForTests,
  verifyLocalPassword,
  localAuthAttemptsTracked,
} from "./localAuth";

const salt = "00112233445566778899aabbccddeeff";
const password = "Senha-Piloto-Forte-2026!";

const admin: User = {
  id: 1,
  openId: "local:syn.admin",
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
    vi.stubEnv("LOCAL_AUTH_USERNAME", "syn.admin");
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
      { username: "syn.admin", password },
      "127.0.0.1",
      Date.parse("2026-09-19T23:00:00Z"),
    );

    expect(result).toEqual(admin);
    expect(dbMocks.upsertUser).toHaveBeenCalledWith(expect.objectContaining({
      openId: "local:syn.admin",
      name: "Lucas Admin",
      loginMethod: "local",
      role: "admin",
    }));
  });

  it("limita tentativas repetidas dentro da mesma janela", async () => {
    for (let index = 0; index < 5; index++) {
      await expect(authenticateLocalUser(
        { username: "syn.admin", password: "Senha-Errada-123456!" },
        "10.0.0.8",
        1_000,
      )).rejects.toMatchObject({ code: "INVALID" });
    }
    await expect(authenticateLocalUser(
      { username: "syn.admin", password },
      "10.0.0.8",
      1_001,
    )).rejects.toMatchObject({ code: "LOCKED" });
  });

  it("recusa login quando o recurso está desabilitado", async () => {
    vi.stubEnv("LOCAL_AUTH_ENABLED", "0");
    await expect(authenticateLocalUser(
      { username: "syn.admin", password },
      "127.0.0.1",
    )).rejects.toBeInstanceOf(LocalAuthError);
  });
});

// GAP-1 do piloto humano: personas finance/service/seller com login local próprio (LOCAL_AUTH_USERS).
describe("local auth — usuários de piloto (LOCAL_AUTH_USERS)", () => {
  const financePassword = "Senha-Financeiro-2026!";
  const financeHash = hashLocalPassword(financePassword, "ffeeddccbbaa99887766554433221100");
  const users = (list: unknown) => vi.stubEnv("LOCAL_AUTH_USERS", JSON.stringify(list));
  const finance = { username: "syn.finance", role: "finance", passwordHash: financeHash, displayName: "SYN Financeiro" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("LOCAL_AUTH_ENABLED", "1");
    vi.stubEnv("LOCAL_AUTH_USERNAME", "syn.admin");
    vi.stubEnv("LOCAL_AUTH_PASSWORD_HASH", hashLocalPassword(password, salt));
    dbMocks.getUserByOpenId.mockImplementation(async (openId: string) => ({ ...admin, openId }));
    resetLocalAuthAttemptsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetLocalAuthAttemptsForTests();
  });

  it("autentica a persona com o papel configurado, não admin", async () => {
    users([finance]);
    await authenticateLocalUser({ username: "syn.finance", password: financePassword }, "127.0.0.1");
    expect(dbMocks.upsertUser).toHaveBeenCalledWith(expect.objectContaining({
      openId: "local:syn.finance", role: "finance", name: "SYN Financeiro", loginMethod: "local",
    }));
  });

  it("senha de outra persona não serve", async () => {
    users([finance]);
    await expect(authenticateLocalUser({ username: "syn.finance", password }, "127.0.0.1"))
      .rejects.toMatchObject({ code: "INVALID" });
    expect(dbMocks.upsertUser).not.toHaveBeenCalled();
  });

  it("o admin principal continua funcionando junto com as personas", async () => {
    users([finance]);
    await authenticateLocalUser({ username: "syn.admin", password }, "127.0.0.1");
    expect(dbMocks.upsertUser).toHaveBeenCalledWith(expect.objectContaining({ openId: "local:syn.admin", role: "admin" }));
  });

  it.each([
    ["JSON inválido", "não-é-json"],
    ["papel fora da lista", JSON.stringify([{ ...finance, role: "superadmin" }])],
    ["papel user não é persona de piloto", JSON.stringify([{ ...finance, role: "user" }])],
    ["username duplicado com o admin", JSON.stringify([{ ...finance, username: "syn.admin" }])],
    ["hash fora do formato scrypt", JSON.stringify([{ ...finance, passwordHash: "plain-text-password" }])],
    ["username inválido", JSON.stringify([{ ...finance, username: "Fin Ance" }])],
  ])("configuração inválida (%s) recusa todo login local", async (_label, raw) => {
    vi.stubEnv("LOCAL_AUTH_USERS", raw);
    expect(localAuthStatus()).toEqual({ enabled: false });
    await expect(authenticateLocalUser({ username: "syn.admin", password }, "127.0.0.1"))
      .rejects.toMatchObject({ code: "MISCONFIGURED" });
  });
});

// Revisão de segurança do GAP-1 (P1/P2).
describe("local auth — WP10 (PRD v4 E0.8): map de tentativas limitado e username primário validado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("LOCAL_AUTH_ENABLED", "1");
    vi.stubEnv("LOCAL_AUTH_USERNAME", "syn.admin");
    vi.stubEnv("LOCAL_AUTH_PASSWORD_HASH", hashLocalPassword(password, salt));
    resetLocalAuthAttemptsForTests();
  });
  afterEach(() => { vi.unstubAllEnvs(); resetLocalAuthAttemptsForTests(); });

  it("P1: o map de tentativas não cresce sem limite (chaves distintas são evictadas ao bater o teto)", async () => {
    // Teto baixo só no teste (padrão 1000 em produção): cada tentativa roda scrypt, 1200 levariam minutos.
    vi.stubEnv("LOCAL_AUTH_MAX_TRACKED", "20");
    for (let i = 0; i < 30; i += 1) {
      await authenticateLocalUser({ username: `syn.user${i}`, password: "errada-errada" }, `client-${i}`).catch(() => undefined);
    }
    expect(localAuthAttemptsTracked()).toBeLessThanOrEqual(20);
    // a chave mais antiga saiu; a mais nova continua contada
    await authenticateLocalUser({ username: "syn.user29", password: "errada-errada" }, "client-29").catch(() => undefined);
    expect(localAuthAttemptsTracked()).toBeLessThanOrEqual(20);
  });

  it("P1 (review): uma chave BLOQUEADA sobrevive à eviction — encher o map com usernames novos não apaga o próprio bloqueio", async () => {
    vi.stubEnv("LOCAL_AUTH_MAX_TRACKED", "20");
    for (let i = 0; i < 5; i += 1) await authenticateLocalUser({ username: "syn.admin", password: "errada-errada" }, "attacker").catch(() => undefined);
    await expect(authenticateLocalUser({ username: "syn.admin", password }, "attacker")).rejects.toMatchObject({ code: "LOCKED" });
    for (let i = 0; i < 40; i += 1) await authenticateLocalUser({ username: `syn.spray${i}`, password: "errada-errada" }, "attacker").catch(() => undefined);
    await expect(authenticateLocalUser({ username: "syn.admin", password }, "attacker")).rejects.toMatchObject({ code: "LOCKED" });
    expect(localAuthAttemptsTracked()).toBeLessThanOrEqual(20);
  });

  it("P1: username primário fora do padrão invalida a configuração em vez de entrar com um openId estranho", async () => {
    vi.stubEnv("LOCAL_AUTH_USERNAME", "Admin Root!");
    expect(localAuthStatus().enabled).toBe(false);
    await expect(authenticateLocalUser({ username: "Admin Root!", password }, "client")).rejects.toMatchObject({ code: "MISCONFIGURED" });
  });
});

describe("local auth — revisão de segurança do GAP-1", () => {
  const financePassword = "Senha-Financeiro-2026!";
  const financeHash = hashLocalPassword(financePassword, "ffeeddccbbaa99887766554433221100");
  const finance = { username: "syn.finance", role: "finance", passwordHash: financeHash };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("LOCAL_AUTH_ENABLED", "1");
    vi.stubEnv("LOCAL_AUTH_USERNAME", "syn.admin");
    vi.stubEnv("LOCAL_AUTH_PASSWORD_HASH", hashLocalPassword(password, salt));
    vi.stubEnv("LOCAL_AUTH_USERS", JSON.stringify([finance]));
    dbMocks.getUserByOpenId.mockImplementation(async (openId: string) => ({ ...admin, openId }));
    resetLocalAuthAttemptsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetLocalAuthAttemptsForTests();
  });

  it("P1: login válido de uma persona não zera as tentativas contra o admin no mesmo IP", async () => {
    for (let i = 0; i < 4; i++) {
      await expect(authenticateLocalUser({ username: "syn.admin", password: "errada-errada-000" }, "10.0.0.9")).rejects.toMatchObject({ code: "INVALID" });
    }
    await authenticateLocalUser({ username: "syn.finance", password: financePassword }, "10.0.0.9");
    await expect(authenticateLocalUser({ username: "syn.admin", password: "errada-errada-000" }, "10.0.0.9")).rejects.toMatchObject({ code: "INVALID" });
    await expect(authenticateLocalUser({ username: "syn.admin", password }, "10.0.0.9")).rejects.toMatchObject({ code: "LOCKED" });
  });

  it("P1: sessão local só vale enquanto a persona existe com o mesmo papel", () => {
    expect(isLocalSessionValid("local:syn.finance", "finance")).toBe(true);
    expect(isLocalSessionValid("local:syn.admin", "admin")).toBe(true);
    expect(isLocalSessionValid("local:syn.finance", "admin")).toBe(false);
    vi.stubEnv("LOCAL_AUTH_USERS", JSON.stringify([{ ...finance, role: "service" }]));
    expect(isLocalSessionValid("local:syn.finance", "finance")).toBe(false);
    vi.stubEnv("LOCAL_AUTH_USERS", "[]");
    expect(isLocalSessionValid("local:syn.finance", "finance")).toBe(false);
    vi.stubEnv("LOCAL_AUTH_ENABLED", "0");
    expect(isLocalSessionValid("local:syn.admin", "admin")).toBe(false);
  });

  it("P2: username acima de 58 caracteres invalida a configuração (openId varchar 64)", () => {
    vi.stubEnv("LOCAL_AUTH_USERS", JSON.stringify([{ ...finance, username: "a".repeat(59) }]));
    expect(localAuthStatus()).toEqual({ enabled: false });
  });

  it("P2: persona que só difere do admin em maiúsculas é colisão", () => {
    vi.stubEnv("LOCAL_AUTH_USERNAME", "SYN.Admin");
    vi.stubEnv("LOCAL_AUTH_USERS", JSON.stringify([{ ...finance, username: "syn.admin" }]));
    expect(localAuthStatus()).toEqual({ enabled: false });
  });
});
