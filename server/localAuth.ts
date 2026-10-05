import { scryptSync, timingSafeEqual } from "node:crypto";
import type { User } from "../drizzle/schema";
import * as db from "./db";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const KEY_LENGTH = 64;

type AttemptState = { count: number; resetAt: number };
const attempts = new Map<string, AttemptState>();
// WP10/E0.8: o map de tentativas é limitado — chaves distintas sem fim (spray de usuários/IPs) não podem crescer a memória.
// Ao bater o teto: descarta janelas expiradas; se ainda cheio, descarta a chave mais antiga (ordem de inserção do Map).
const maxTrackedKeys = () => Math.max(10, Number(process.env.LOCAL_AUTH_MAX_TRACKED ?? 1000) || 1000);
function evictIfFull(now: number) {
  const limit = maxTrackedKeys();
  if (attempts.size < limit) return;
  attempts.forEach((state, key) => { if (now >= state.resetAt) attempts.delete(key); }); // tsconfig sem downlevelIteration: sem for-of no Map
  // Review: expulsar primeiro chaves NÃO bloqueadas — senão um atacante enche o map com usernames novos para apagar o próprio bloqueio.
  while (attempts.size >= limit) {
    let victim: string | undefined;
    attempts.forEach((state, key) => { if (victim === undefined && state.count < MAX_ATTEMPTS) victim = key; });
    if (victim === undefined) victim = attempts.keys().next().value; // só bloqueadas: cai na mais antiga
    if (victim === undefined) break;
    attempts.delete(victim);
  }
}
/** Só para testes: quantas chaves estão sendo acompanhadas. */
export function localAuthAttemptsTracked() { return attempts.size; }

export class LocalAuthError extends Error {
  constructor(
    message: string,
    readonly code: "DISABLED" | "INVALID" | "LOCKED" | "MISCONFIGURED",
  ) {
    super(message);
    this.name = "LocalAuthError";
  }
}

// Personas de piloto (GAP-1): só papéis comerciais; "user" e papéis desconhecidos não entram.
const PILOT_ROLES = ["admin", "seller", "finance", "service"] as const;
type LocalRole = (typeof PILOT_ROLES)[number];
type LocalAccount = { username: string; passwordHash: string; displayName: string; role: LocalRole };
// Hash fictício para rodar o scrypt mesmo com usuário inexistente (não revela usernames pelo tempo).
const DUMMY_HASH = `scrypt:${"00".repeat(16)}:${"00".repeat(KEY_LENGTH)}`;

/** Lê LOCAL_AUTH_USERS (JSON). Qualquer item inválido invalida a configuração inteira (fail closed). */
function pilotAccounts(raw: string, taken: Set<string>): LocalAccount[] | null {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const accounts: LocalAccount[] = [];
  for (const item of parsed) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const { username, role, passwordHash, displayName } = entry;
    // 58 = varchar(64) do openId menos o prefixo "local:"; colisão comparada sem caixa (collation do MySQL).
    if (typeof username !== "string" || !/^[a-z0-9._-]{3,58}$/.test(username) || taken.has(username)) return null;
    if (typeof role !== "string" || !(PILOT_ROLES as readonly string[]).includes(role)) return null;
    if (typeof passwordHash !== "string" || !/^scrypt:[0-9a-f]{32,128}:[0-9a-f]{128}$/i.test(passwordHash)) return null;
    taken.add(username);
    accounts.push({ username, passwordHash, role: role as LocalRole, displayName: typeof displayName === "string" && displayName.trim() ? displayName.trim() : username });
  }
  return accounts;
}

function config() {
  const enabled = process.env.LOCAL_AUTH_ENABLED === "1";
  const username = process.env.LOCAL_AUTH_USERNAME?.trim() ?? "";
  const passwordHash = process.env.LOCAL_AUTH_PASSWORD_HASH?.trim() ?? "";
  // WP10/E0.8: o admin primário segue a MESMA regra das personas (openId `local:<username>` cabe em varchar 64, sem espaço/maiúscula).
  const primaryValid = !username || /^[a-z0-9._-]{3,58}$/.test(username);
  const primary: LocalAccount[] = username && passwordHash && primaryValid
    ? [{ username, passwordHash, role: "admin", displayName: process.env.LOCAL_AUTH_DISPLAY_NAME?.trim() || "Administrador TGR" }]
    : [];
  const extra = pilotAccounts(process.env.LOCAL_AUTH_USERS?.trim() ?? "", new Set(primary.map(account => account.username.toLowerCase())));
  return { enabled, valid: primaryValid && extra !== null, accounts: !primaryValid || extra === null ? [] : [...primary, ...extra] };
}

/** Sessão local (`local:<username>`) só vale se a persona ainda existe com o mesmo papel (troca/remoção derruba sessões). */
export function isLocalSessionValid(openId: string, role: string): boolean {
  const value = config();
  if (!value.enabled || !value.valid) return false;
  const account = value.accounts.find(candidate => `local:${candidate.username}` === openId);
  return Boolean(account && account.role === role);
}

export function localAuthStatus() {
  const value = config();
  return { enabled: value.enabled && value.valid && value.accounts.length > 0 };
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
    if (!current) evictIfFull(now);
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
  if (!value.valid || value.accounts.length === 0) {
    throw new LocalAuthError("Login local não configurado.", "MISCONFIGURED");
  }

  // Tentativas por (cliente, usuário): o login válido de uma persona não zera as tentativas contra outra.
  const key = `${clientKey || "unknown"}|${input.username.trim().toLowerCase()}`;
  assertAttemptAllowed(key, now);

  const account = value.accounts.find(candidate => candidate.username === input.username.trim());
  const passwordMatches = verifyLocalPassword(input.password, account?.passwordHash ?? DUMMY_HASH);
  if (!account || !passwordMatches) {
    recordFailure(key, now);
    throw new LocalAuthError("Usuário ou senha inválidos.", "INVALID");
  }
  clearFailures(key);

  const openId = `local:${account.username}`;
  await db.upsertUser({
    openId,
    name: account.displayName,
    email: null,
    loginMethod: "local",
    role: account.role,
    lastSignedIn: new Date(now),
  });
  const user = await db.getUserByOpenId(openId);
  if (!user) throw new LocalAuthError("Usuário local não pôde ser criado.", "MISCONFIGURED");
  return user;
}

export function resetLocalAuthAttemptsForTests() {
  attempts.clear();
}
