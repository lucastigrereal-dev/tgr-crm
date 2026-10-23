// F1.8 / CRM-a e CRM-b: consumo do prefill do GuestPass (contrato guestpass.prefill.v1, dono: tgr-guestpass; fixture em docs/contracts/fixtures)
// e vínculo único passe <-> ficha. PULL sob demanda, sem fila, sem cache. A resposta tem lista fechada de campos: qualquer campo proibido
// (cpf, renda, veículo...) faz a resposta inteira ser descartada. NADA do corpo (nome, telefone) vai para log nem auditoria: só o Nº do passe e ids.
import { and, eq, isNull, like } from "drizzle-orm";
import type { MySqlDatabase } from "drizzle-orm/mysql-core";
import type { MySql2PreparedQueryHKT, MySql2QueryResultHKT } from "drizzle-orm/mysql2";
import { z } from "zod";
import { captureGuestpassLinks, captureRecords, customers } from "../drizzle/schema";
import { GUESTPASS_PASS_REF_PATTERN, resolveGuestpassConfig } from "./guestpassConfig";
import { isDuplicateKeyError } from "./mysqlErrors";
import { txAudit, type Tx } from "./txOutbox";

const FORBIDDEN_KEYS = ["cpf", "monthlyIncome", "carModel", "carYear", "trips", "notes", "familyComposition", "courtesy", "time"] as const;
const text = (max: number) => z.string().trim().min(1).max(max);

const prefillSchema = z.object({
  contractVersion: z.literal(1),
  guestPassId: z.string().regex(GUESTPASS_PASS_REF_PATTERN),
  status: z.enum(["confirmed", "show_qualified"]),
  visitDate: z.string().date().nullish(),
  origin: z.object({ captorId: text(80).nullish(), pointId: text(80).nullish(), channel: text(40).nullish() }).strict().partial().nullish(),
  couple: z.object({
    primaryName: text(255), secondaryName: text(255).nullish(), phone: text(32), cityUf: text(120).nullish(), lodging: text(255).nullish(),
  }).strict(),
  guestPassConsentVersion: text(200).nullish(),
}).strict();

export type GuestpassPrefill = z.infer<typeof prefillSchema>;

export type PrefillResult =
  | { kind: "ok"; prefill: GuestpassPrefill }
  | { kind: "not_found" | "unauthorized" | "rate_limited" | "unavailable" | "not_configured" | "invalid_response"; retryAfterSeconds?: number };

function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) return false;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key) || hasForbiddenKey(inner, depth + 1)) return true;
  }
  return false;
}

/** Busca o prefill do passe. Nunca lança por falha de rede/HTTP: devolve o motivo. 404 é uniforme (não diz se o passe existe). */
export async function fetchGuestpassPrefill(passRef: string, fetchImpl: typeof fetch = fetch): Promise<PrefillResult> {
  const config = resolveGuestpassConfig();
  if (!config.enabled || !config.configured) return { kind: "not_configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/api/integrations/crm/prefill/${encodeURIComponent(passRef)}`, {
      method: "GET", headers: { authorization: `Bearer ${config.key}`, accept: "application/json" }, signal: controller.signal, redirect: "error",
    });
    if (response.status === 404) return { kind: "not_found" };
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 429) {
      const retry = Number(response.headers.get("retry-after"));
      return { kind: "rate_limited", ...(Number.isInteger(retry) && retry >= 1 && retry <= 60 ? { retryAfterSeconds: retry } : {}) };
    }
    if (response.status !== 200) return { kind: "unavailable" };
    const raw: unknown = await response.json();
    if (hasForbiddenKey(raw)) return { kind: "invalid_response" };
    const parsed = prefillSchema.safeParse(raw);
    // O passe devolvido tem que ser o pedido: resposta de outro passe nunca preenche a ficha.
    if (!parsed.success || parsed.data.guestPassId !== passRef) return { kind: "invalid_response" };
    return { kind: "ok", prefill: parsed.data };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Campos do formulário de ficha (só estes); "Cidade/UF" é separado quando tem o formato esperado. */
export function prefillToFormFields(prefill: GuestpassPrefill) {
  const cityUf = prefill.couple.cityUf ?? "";
  const match = /^(.*?)\s*\/\s*([A-Za-z]{2})$/.exec(cityUf);
  return {
    fullName: prefill.couple.primaryName,
    partnerName: prefill.couple.secondaryName ?? "",
    phone: prefill.couple.phone,
    city: match ? match[1].trim() : cityUf,
    state: match ? match[2].toUpperCase() : "",
    lodgingLocation: prefill.couple.lodging ?? "",
    captureLocation: prefill.origin?.pointId ?? "",
    visitDate: prefill.visitDate ?? null,
  };
}

// A transação do drizzle estende o banco: as funções valem para os dois.
export type Executor = MySqlDatabase<MySql2QueryResultHKT, MySql2PreparedQueryHKT, Record<string, unknown>>;

export class GuestpassLinkConflict extends Error {
  constructor(readonly reason: "pass_taken" | "capture_has_pass", readonly otherCaptureId?: number) { super(reason); }
}

/** Vincula o passe à ficha (1 passe : 1 ficha). Repetir o mesmo par é no-op; passe de outra ficha ou ficha com outro passe = GuestpassLinkConflict. */
export async function linkGuestpassToCapture(tx: Tx, input: { captureId: number; passRef: string; actorUserId: number | null; fetchedAt?: Date | null }) {
  const [byPass] = await tx.select().from(captureGuestpassLinks).where(eq(captureGuestpassLinks.guestpassPassRef, input.passRef)).limit(1);
  if (byPass) {
    if (byPass.captureId === input.captureId) return { created: false as const, captureId: byPass.captureId };
    throw new GuestpassLinkConflict("pass_taken", byPass.captureId);
  }
  const [byCapture] = await tx.select().from(captureGuestpassLinks).where(eq(captureGuestpassLinks.captureId, input.captureId)).limit(1);
  if (byCapture) throw new GuestpassLinkConflict("capture_has_pass");
  try {
    await tx.insert(captureGuestpassLinks).values({ captureId: input.captureId, guestpassPassRef: input.passRef, prefillFetchedAt: input.fetchedAt ?? null, createdByUserId: input.actorUserId });
  } catch (error) {
    // Corrida entre dois cliques: a unique decide.
    if (isDuplicateKeyError(error)) throw new GuestpassLinkConflict("pass_taken");
    throw error;
  }
  await txAudit(tx, { actorUserId: input.actorUserId, entityType: "capture", entityId: input.captureId, action: "guestpass_linked", summary: `Ficha ${input.captureId}: vinculada ao passe ${input.passRef}.` });
  return { created: true as const, captureId: input.captureId };
}

export async function findLinkByPass(tx: Executor, passRef: string) {
  return (await tx.select().from(captureGuestpassLinks).where(eq(captureGuestpassLinks.guestpassPassRef, passRef)).limit(1))[0] ?? null;
}

const digitsOnly = (value: string) => value.replace(/\D/g, "");

/** Candidatos por telefone: fichas já existentes cujo cliente tem o mesmo telefone (comparação pelos 8 últimos dígitos). Devolve só ids e nome, para a equipe escolher; NUNCA vincula sozinho. */
export async function findPhoneCandidates(tx: Executor, phone: string, limit = 5) {
  const digits = digitsOnly(phone);
  if (digits.length < 8) return [];
  const tail = digits.slice(-8);
  const rows = await tx.select({ captureId: captureRecords.id, customerId: customers.id, fullName: customers.fullName, phone: customers.phone, scheduledAt: captureRecords.scheduledAt, linkedPass: captureGuestpassLinks.guestpassPassRef })
    .from(captureRecords)
    .innerJoin(customers, eq(customers.id, captureRecords.customerId))
    .leftJoin(captureGuestpassLinks, eq(captureGuestpassLinks.captureId, captureRecords.id))
    .where(and(like(customers.phone, `%${tail.slice(-4)}%`), isNull(customers.anonymizedAt)))
    .limit(200);
  return rows
    .filter(row => !!row.phone && digitsOnly(row.phone).endsWith(tail))
    .sort((a, b) => b.captureId - a.captureId)
    .slice(0, limit)
    .map(row => ({ captureId: row.captureId, customerId: row.customerId, fullName: row.fullName, scheduledAt: row.scheduledAt, alreadyLinked: !!row.linkedPass }));
}
