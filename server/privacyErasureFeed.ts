import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { privacyErasureReceipts } from "../drizzle/schema";
import type { getDb } from "./db";
import { logger } from "./logger";
import { processErasureEvent } from "./privacyErasure";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * F2.10: cliente PULL do feed de exclusão do GuestPass (GET lista, POST recibo). Desenho: docs/design/ERASURE_PROPAGADA.md (GuestPass) e docs/design/PRIVACY_ERASURE_PROPAGADA_CRM.md.
 * Só roda com PRIVACY_ERASURE_PROPAGATION_ENABLED=true e com endpoint, chave e segredo configurados. Nada de corpo, CPF, HMAC ou nome em log. Falha do GuestPass nunca derruba o CRM.
 * ATENÇÃO: o formato exato da lista (`events`, `nextCursor`) segue o desenho; o GuestPass ainda não publicou o endpoint, então é premissa a confirmar antes de ligar.
 */
export type ErasureFeedConfig = { endpoint: string; key: string; hmacSecret: string; fetchImpl?: typeof fetch; pageSize?: number; maxPages?: number; timeoutMs?: number };
export type ErasureSyncOutcome = { pages: number; received: number; processed: number; invalid: number; receiptsDelivered: number; receiptsFailed: number; stopped: "done" | "rate_limited" | "unavailable" | "unauthorized" | "max_pages" };

const feedPage = z.object({ events: z.array(z.unknown()).max(100), nextCursor: z.string().max(200).nullable().optional() });

export function isAllowedFeedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
  } catch { return false; }
}

async function call(config: ErasureFeedConfig, url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
  try { return await (config.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal, headers: { ...(init.headers ?? {}), authorization: `Bearer ${config.key}`, "content-type": "application/json" } }); }
  finally { clearTimeout(timer); }
}

export async function runErasureSync(db: Db, config: ErasureFeedConfig): Promise<ErasureSyncOutcome> {
  const out: ErasureSyncOutcome = { pages: 0, received: 0, processed: 0, invalid: 0, receiptsDelivered: 0, receiptsFailed: 0, stopped: "done" };
  if (!isAllowedFeedEndpoint(config.endpoint) || !config.key || !config.hmacSecret) { out.stopped = "unavailable"; return out; }
  const base = config.endpoint.replace(/\/+$/, "");
  let cursor: string | null = null;
  for (let page = 0; page < (config.maxPages ?? 5); page++) {
    let response: Response;
    try { response = await call(config, `${base}?limit=${config.pageSize ?? 50}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`, { method: "GET" }); }
    catch { out.stopped = "unavailable"; break; }
    if (response.status === 429) { out.stopped = "rate_limited"; break; }
    if (response.status === 401 || response.status === 403) { out.stopped = "unauthorized"; break; }
    if (!response.ok) { out.stopped = "unavailable"; break; }
    const parsed = feedPage.safeParse(await response.json().catch(() => null));
    if (!parsed.success) { out.stopped = "unavailable"; break; }
    out.pages++;
    for (const raw of parsed.data.events) {
      out.received++;
      try { await processErasureEvent(db, raw, { hmacSecret: config.hmacSecret }); out.processed++; }
      catch (error) {
        // Evento fora do contrato é contado e pulado (o GuestPass reentrega o que não tiver recibo). Nada do corpo vai ao log.
        if (error instanceof z.ZodError) out.invalid++;
        else { out.invalid++; logger.error("Privacy erasure event failed", { errorName: error instanceof Error ? error.name : "non-Error" }); }
      }
    }
    cursor = parsed.data.nextCursor ?? null;
    if (!cursor) { out.stopped = "done"; break; }
    if (page === (config.maxPages ?? 5) - 1) out.stopped = "max_pages";
  }
  // 401/403 e 429 INTERROMPEM a rodada (desenho): sem chamadas autenticadas que já se sabe que falham e sem ignorar o backoff do GuestPass. Os recibos pendentes saem na próxima rodada.
  if (out.stopped === "unauthorized" || out.stopped === "rate_limited") return out;
  // Recibos do CRM ainda não entregues (inclui os de rodadas anteriores que falharam).
  const pending = await db.select().from(privacyErasureReceipts).where(and(eq(privacyErasureReceipts.system, "crm"), isNull(privacyErasureReceipts.deliveredAt))).orderBy(asc(privacyErasureReceipts.id)).limit(100);
  for (const receipt of pending) {
    try {
      const response = await call(config, `${base}/${encodeURIComponent(receipt.eventId)}/receipt`, { method: "POST", body: JSON.stringify({ system: "crm", status: receipt.status, at: new Date(receipt.receiptAt).toISOString(), detail: receipt.detail ?? "" }) });
      if (response.ok) { await db.update(privacyErasureReceipts).set({ deliveredAt: new Date() }).where(eq(privacyErasureReceipts.id, receipt.id)); out.receiptsDelivered++; }
      else out.receiptsFailed++;
    } catch { out.receiptsFailed++; }
  }
  return out;
}
