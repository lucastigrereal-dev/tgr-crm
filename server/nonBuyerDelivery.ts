import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { captureMotives, captureRecords, customers, domainEvents, financialProjectMap, nonBuyerDeliveries, nonBuyerEligibilityState, resorts } from "../drizzle/schema";
import type { getDb } from "./db";
import { logger } from "./logger";
import { evaluateNonBuyerEligibility, loadEligibilityFacts } from "./nonBuyerEligibility";
import { reevaluateCapture } from "./nonBuyerEligibilityService";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * F2.1 (fatia 5): ENTREGA dos eventos internos non_buyer.eligible / non_buyer.eligibility_revoked ao Recovery. Contrato: docs/design/NON_BUYER_ENTREGA_RECOVERY.md e
 * docs/contracts/fixtures/crm.non_buyer.v1.fixtures.json. Só roda com NON_BUYER_DELIVERY_ENABLED=true (nasce false) E RECOVERY_ELIGIBILITY_ENABLED=true, com endpoint e chave.
 *
 * - O livro `non_buyer_deliveries` (PROPOSTA 0089) guarda o estado de cada entrega; NUNCA guarda PII. Nome e telefone são lidos do cliente NO MOMENTO do envio e vão só no corpo HTTP.
 * - REVALIDAÇÃO NA ENTREGA: logo antes de enviar "elegível", o predicado é recalculado; se o casal foi anonimizado, fez opt-out ou comprou entre a gravação e a entrega, NÃO envia, marca
 *   `suppressed` e a reavaliação emite o revogado correspondente.
 * - SÓ O ESTADO VIGENTE VALE: evento cujo `seq` ficou abaixo da projeção é `superseded` (o mais novo da ficha carrega a verdade). Revogado só é enviado se um elegível dessa ficha foi entregue.
 * - Falha (rede, 5xx, 401/403/404, 429) tenta de novo com backoff persistido; recusa 4xx com `code` (exceto 408/425/429) é terminal (`rejected`). Replay no Recovery é idempotente por eventId + chave de dedupe.
 * - Nada do corpo, do contato, da resposta ou do coupleCode vai a log: só eventId e status HTTP.
 */
export const DELIVERY_EVENT_NAMES = ["non_buyer.eligible", "non_buyer.eligibility_revoked"] as const;
export const RETRY_BASE_MS = 5_000;
export const RETRY_CAP_MS = 10 * 60_000;
export const DEFAULT_TIMEZONE = "America/Recife";
const EVENT_ID = /^crm-nb-(\d+)-(eligible|revoked)-(\d+)$/;
const CODED = /^[A-Z0-9_]{1,80}$/;

export type DeliveryConfig = { endpoint: string; key: string; fetchImpl?: typeof fetch; timeoutMs?: number; batch?: number; now?: () => Date };
export type DeliveryOutcome = { discovered: number; delivered: number; superseded: number; suppressed: number; rejected: number; retried: number };

export const backoffMs = (attempts: number) => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS);

/** Data civil (YYYY-MM-DD) do instante no fuso do projeto. Parte da chave de dedupe do Recovery. */
export function encounterDateIn(instant: Date, timezone: string): string {
  let tz = timezone;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); } catch { tz = DEFAULT_TIMEZONE; }
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Chave de dedupe do Recovery: o mesmo casal no mesmo dia de atendimento é UM caso, mesmo que o CRM reemita. */
export const dedupeKeyOf = (coupleCode: string, encounterDate: string) => `${coupleCode}:${encounterDate}`;

export const isAllowedDeliveryEndpoint = (endpoint: string) => {
  try { const url = new URL(endpoint); return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")); } catch { return false; }
};

export type EligibleBody = {
  eventId: string; source: "crm"; occurredAt: string; project: { externalKey: string; name: string; timezone: string }; coupleCode: string; coupleId: string; encounterDate: string; dedupeKey: string;
  eligibleAt: string; lastEncounterAt: string; branch: "closed" | "no_tour"; reasonCode: string | null; consentVersion: string | null; channels: string[]; contact: { name: string; phone: string | null };
};
export type RevokedBody = { eventId: string; source: "crm"; coupleCode: string; encounterDate: string; dedupeKey: string; revokedAt: string; reason: string };

async function postDelivery(config: DeliveryConfig, path: string, eventId: string, body: unknown): Promise<{ status: number; code: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
  try {
    const response = await (config.fetchImpl ?? fetch)(`${config.endpoint.replace(/\/+$/, "")}${path}`, {
      method: "POST", signal: controller.signal, body: JSON.stringify(body),
      headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json", "idempotency-key": eventId },
    });
    const code = response.ok ? null : await response.json().then((json: unknown) => (json && typeof json === "object" && typeof (json as { code?: unknown }).code === "string" && CODED.test((json as { code: string }).code) ? (json as { code: string }).code : null)).catch(() => null);
    return { status: response.status, code };
  } catch { return null; } finally { clearTimeout(timer); }
}

const isTerminalRejection = (status: number, code: string | null) => code != null && status >= 400 && status < 500 && ![408, 425, 429].includes(status);

async function discover(db: Db, limit: number) {
  const rows = await db.select({ eventId: domainEvents.idempotencyKey }).from(domainEvents)
    .leftJoin(nonBuyerDeliveries, eq(nonBuyerDeliveries.eventId, domainEvents.idempotencyKey))
    .where(and(inArray(domainEvents.eventName, [...DELIVERY_EVENT_NAMES]), isNull(nonBuyerDeliveries.id))).orderBy(asc(domainEvents.id)).limit(limit);
  let added = 0;
  for (const { eventId } of rows) {
    const match = eventId ? EVENT_ID.exec(eventId) : null;
    if (!eventId || !match) continue;
    await db.insert(nonBuyerDeliveries).values({ eventId, captureId: Number(match[1]), seq: Number(match[3]), kind: match[2] as "eligible" | "revoked" }).onDuplicateKeyUpdate({ set: { eventId: sql`eventId` } });
    added++;
  }
  return added;
}

type Row = typeof nonBuyerDeliveries.$inferSelect;

export async function runNonBuyerDelivery(db: Db, config: DeliveryConfig): Promise<DeliveryOutcome> {
  const out: DeliveryOutcome = { discovered: 0, delivered: 0, superseded: 0, suppressed: 0, rejected: 0, retried: 0 };
  if (!isAllowedDeliveryEndpoint(config.endpoint) || !config.key) return out;
  const now = () => (config.now ?? (() => new Date()))();
  out.discovered = await discover(db, 200);

  const settle = (row: Row, status: Row["status"], reason: string | null, extra: Partial<Row> = {}) =>
    db.update(nonBuyerDeliveries).set({ status, reason, nextAttemptAt: null, ...extra }).where(eq(nonBuyerDeliveries.id, row.id));
  const retry = async (row: Row, reason: string, httpStatus: number | null) => {
    const attempts = row.attempts + 1;
    await db.update(nonBuyerDeliveries).set({ attempts, reason, lastHttpStatus: httpStatus, nextAttemptAt: new Date(now().getTime() + backoffMs(attempts)) }).where(eq(nonBuyerDeliveries.id, row.id));
    out.retried++;
  };

  const due = await db.select().from(nonBuyerDeliveries)
    .where(and(eq(nonBuyerDeliveries.status, "pending"), or(isNull(nonBuyerDeliveries.nextAttemptAt), lte(nonBuyerDeliveries.nextAttemptAt, now()))))
    .orderBy(asc(nonBuyerDeliveries.captureId), asc(nonBuyerDeliveries.seq)).limit(config.batch ?? 100);

  for (const row of due) {
    try {
      const [state] = await db.select().from(nonBuyerEligibilityState).where(eq(nonBuyerEligibilityState.captureId, row.captureId)).limit(1);
      if (!state) { await retry(row, "no_state", null); continue; }
      if (row.seq < state.seq) { await settle(row, "superseded", "newer_event"); out.superseded++; continue; }

      const [event] = await db.select({ payload: domainEvents.payload, occurredAt: domainEvents.occurredAt }).from(domainEvents).where(eq(domainEvents.idempotencyKey, row.eventId)).limit(1);
      if (!event) { await retry(row, "no_event", null); continue; }

      if (row.kind === "revoked") {
        const [sent] = await db.select({ id: nonBuyerDeliveries.id }).from(nonBuyerDeliveries).where(and(eq(nonBuyerDeliveries.captureId, row.captureId), eq(nonBuyerDeliveries.kind, "eligible"), eq(nonBuyerDeliveries.status, "delivered"))).limit(1);
        if (!sent) { await settle(row, "suppressed", "never_delivered"); out.suppressed++; continue; }
      } else {
        // Revalidação: o predicado é recalculado AGORA, com o opt-out lido.
        const facts = await loadEligibilityFacts(db, row.captureId, { readOptOut: true });
        const verdict = facts ? evaluateNonBuyerEligibility(facts) : null;
        if (!verdict || !verdict.eligible) {
          await settle(row, "suppressed", "revalidated_ineligible");
          out.suppressed++;
          // A reavaliação emite o revogado (transição da projeção); como nenhum elegível foi entregue, ele mesmo será suprimido na próxima volta.
          await db.transaction(tx => reevaluateCapture(tx, row.captureId)).catch(() => null);
          continue;
        }
      }

      const [ctx] = await db.select({
        coupleCode: captureRecords.coupleCode, resortId: captureRecords.resortId, presentationEndedAt: captureRecords.presentationEndedAt, ntRecordedAt: captureRecords.ntRecordedAt, checkedInAt: captureRecords.checkedInAt,
        ntMotiveId: captureRecords.ntMotiveId, fullName: customers.fullName, phone: customers.phone,
      }).from(captureRecords).innerJoin(customers, eq(customers.id, captureRecords.customerId)).where(eq(captureRecords.id, row.captureId)).limit(1);
      if (!ctx || !ctx.coupleCode) { await retry(row, "no_couple_code", null); continue; }
      const [resort] = ctx.resortId ? await db.select({ externalKey: resorts.externalKey, name: resorts.name }).from(resorts).where(eq(resorts.id, ctx.resortId)).limit(1) : [];
      const [mapped] = ctx.resortId ? await db.select({ externalKey: financialProjectMap.externalKey, name: financialProjectMap.name, timezone: financialProjectMap.timezone }).from(financialProjectMap).where(and(eq(financialProjectMap.resortId, ctx.resortId), eq(financialProjectMap.active, true))).limit(1) : [];
      const projectKey = resort?.externalKey ?? mapped?.externalKey ?? null;
      if (!projectKey) { await retry(row, "no_project", null); continue; }
      const timezone = mapped?.timezone ?? DEFAULT_TIMEZONE;
      const occurredAt = event.occurredAt;
      const encounterAt = ctx.presentationEndedAt ?? ctx.ntRecordedAt ?? ctx.checkedInAt ?? occurredAt;
      const encounterDate = encounterDateIn(encounterAt, timezone);
      const dedupeKey = dedupeKeyOf(ctx.coupleCode, encounterDate);
      const payload = (() => { try { return JSON.parse(event.payload ?? "{}") as { branch?: string; reason?: string }; } catch { return {}; } })();

      let path: string;
      let body: EligibleBody | RevokedBody;
      if (row.kind === "eligible") {
        const [motive] = ctx.ntMotiveId ? await db.select({ code: captureMotives.code }).from(captureMotives).where(eq(captureMotives.id, ctx.ntMotiveId)).limit(1) : [];
        path = "/non-buyer/eligible";
        body = {
          eventId: row.eventId, source: "crm", occurredAt: occurredAt.toISOString(), project: { externalKey: projectKey, name: resort?.name ?? mapped?.name ?? projectKey, timezone },
          coupleCode: ctx.coupleCode, coupleId: `crm-capture-${row.captureId}`, encounterDate, dedupeKey, eligibleAt: occurredAt.toISOString(), lastEncounterAt: encounterAt.toISOString(),
          branch: payload.branch === "no_tour" ? "no_tour" : "closed", reasonCode: motive?.code ?? null, consentVersion: null, channels: [],
          contact: { name: ctx.fullName, phone: ctx.phone ?? null },
        };
      } else {
        path = "/non-buyer/eligibility-revoked";
        body = { eventId: row.eventId, source: "crm", coupleCode: ctx.coupleCode, encounterDate, dedupeKey, revokedAt: occurredAt.toISOString(), reason: payload.reason ?? "unknown" };
      }

      const result = await postDelivery(config, path, row.eventId, body);
      if (!result) { await retry(row, "network", null); continue; }
      if (result.status >= 200 && result.status < 300) { await settle(row, "delivered", null, { attempts: row.attempts + 1, lastHttpStatus: result.status, deliveredAt: now() }); out.delivered++; continue; }
      if (isTerminalRejection(result.status, result.code)) { await settle(row, "rejected", result.code, { attempts: row.attempts + 1, lastHttpStatus: result.status }); out.rejected++; logger.warn("Non-buyer delivery rejected", { eventId: row.eventId, status: result.status }); continue; }
      await retry(row, `http_${result.status}`, result.status);
    } catch (error) {
      logger.error("Non-buyer delivery failed", { eventId: row.eventId, errorName: error instanceof Error ? error.name : "non-Error" });
      await retry(row, "internal_error", null).catch(() => null);
    }
  }
  return out;
}
