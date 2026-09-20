import { scryptSync, timingSafeEqual } from "node:crypto";
import type { User } from "../drizzle/schema";
import * as db from "./db";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const KEY_LENGTH = 64;

type AttemptState = { count: number; resetAt: number };
const attempts = new Map<string, AttemptState>();

export class LocalAuthError extends Error {
  constructor(
    message: string,
    readonly code: "DISABLED" | "INVALID" | "LOCKED" | "MISCONFIGURED",
  ) {
    super(message);
    this.name = "LocalAuthError";
  }
}

function config() {
  return {
    enabled: process.env.LOCAL_AUTH_ENABLED === "1",
    username: process.env.LOCAL_AUTH_USERNAME?.trim() ?? "",
    passwordHash: process.env.LOCAL_AUTH_PASSWORD_HASH?.trim() ?? "",
    displayName: process.env.LOCAL_AUTH_DISPLAY_NAME?.trim() || "Administrador TGR",
  };
}

export function localAuthStatus() {
  const value = config();
  return { enabled: value.enabled && Boolean(value.username && value.passwordHash) };
}
export function hashLocalPassword(password: string, saltHex: string): string {
  if (password.length < 12) throw new Error("Senha local precisa ter pelo menos 12 caracteres.");
  if (!/^[0-9a-f]{32,128}$/i.test(saltHex)) throw new Error("Salt local inválido.");
  const digest = scryptSync(password, Buffer.from(saltHex, "hex"), KEY_LENGTH);
  return `scrypt:${saltHex.toLowerCase()}:${digest.toString("hex")}`;
}

export function verifyLocalPassword(password: string, encoded: string): boolean {
  const separator = encoded.includes(":") ? ":" : "$";
  const [scheme, saltHex, expectedHex] = encoded.split(separator);
  if (scheme !== "scrypt" || !saltHex || !expectedHex) return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertAttemptAllowed(key: string, now: number) {
  const state = attempts.get(key);
  if (!state) return;
  if (now >= state.resetAt) {
    attempts.delete(key);
    return;
  }
  if (state.count >= MAX_ATTEMPTS) {
    throw new LocalAuthError("Muitas tentativas. Aguarde alguns minutos.", "LOCKED");
  }
}

function recordFailure(key: string, now: number) {
  const current = attempts.get(key);
  if (!current || now >= current.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  current.count += 1;
}

function clearFailures(key: string) {
  attempts.delete(key);
}
export async function authenticateLocalUser(
  input: { username: string; password: string },
  clientKey: string,
  now = Date.now(),
): Promise<User> {
  const value = config();
  if (!value.enabled) throw new LocalAuthError("Login local desabilitado.", "DISABLED");
  if (!value.username || !value.passwordHash) {
    throw new LocalAuthError("Login local não configurado.", "MISCONFIGURED");
  }

  const key = clientKey || "unknown";
  assertAttemptAllowed(key, now);

  const usernameMatches = input.username.trim() === value.username;
  const passwordMatches = verifyLocalPassword(input.password, value.passwordHash);
  if (!usernameMatches || !passwordMatches) {
    recordFailure(key, now);
    throw new LocalAuthError("Usuário ou senha inválidos.", "INVALID");
  }
  clearFailures(key);

  const openId = `local:${value.username}`;
  await db.upsertUser({
    openId,
    name: value.displayName,
    email: null,
    loginMethod: "local",
    role: "admin",
    lastSignedIn: new Date(now),
  });
  const user = await db.getUserByOpenId(openId);
  if (!user) throw new LocalAuthError("Usuário local não pôde ser criado.", "MISCONFIGURED");
  return user;
}

export function resetLocalAuthAttemptsForTests() {
  attempts.clear();
}
