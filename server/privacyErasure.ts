import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, customers, privacyErasureEvents, privacyErasureReceipts } from "../drizzle/schema";
import { applyCustomerAnonymization, erasureBlockers } from "./captureErasure";
import type { getDb } from "./db";
import { isDuplicateKeyError, withDeadlockRetry } from "./mysqlErrors";
import { eligibilityHook } from "./nonBuyerEligibilityService";
import { txAudit, txEvent } from "./txOutbox";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * F2.10 (lado CRM): exclusão LGPD propagada. O GuestPass publica `privacy.erasure.requested.v1` (feed por pull, desenho em docs/design/ERASURE_PROPAGADA.md do GuestPass);
 * o CRM anonimiza SÓ o que é dele, mantendo o mínimo legal (nome, CPF, data do brinde), e devolve um recibo. Nada aqui chama outro sistema: o fan-out para Sales, Recovery,
 * Relationship e Financial é o evento interno `privacy.erasure.requested` (consumo por contrato novo, Suite -> CRM -> re-pin).
 * O titular é achado por HMAC do CPF (segredo da ponte): o CPF em claro nunca viaja nem entra em log, evento ou recibo. `mode: full` NÃO é executado sozinho (decisão em aberto).
 */

export const ERASURE_SYSTEMS = ["crm", "sales", "recovery", "relationship", "financial"] as const;
export type ErasureSystem = (typeof ERASURE_SYSTEMS)[number];
export type ReceiptStatus = "done" | "partial" | "failed" | "nothing_to_erase";

const isoDate = z.string().max(40).refine(value => !Number.isNaN(Date.parse(value)), "data inválida");
export const erasureEventSchema = z.object({
  contractVersion: z.literal(1),
  eventId: z.string().trim().min(8).max(120),
  type: z.literal("privacy.erasure.requested.v1"),
  guestPassId: z.string().trim().max(40).optional(),
  requestId: z.number().int().positive().optional(),
  mode: z.enum(["minimal", "full"]),
  keep: z.array(z.enum(["name", "cpf", "benefitDate"])).max(3),
  requestedAt: isoDate.optional(),
  fulfilledAt: isoDate.optional(),
  subjectRefs: z.object({ cpfHmac: z.string().regex(/^[0-9a-f]{64}$/, "HMAC hex de 64 caracteres") }),
});
export type ErasureEvent = z.infer<typeof erasureEventSchema>;

/** HMAC-SHA256 (hex) do CPF normalizado (só dígitos) com o segredo da ponte. Só CPF de 11 dígitos tem identificador. */
export function cpfHmac(rawCpf: string | null | undefined, secret: string): string | null {
  const digits = (rawCpf ?? "").replace(/\D/g, "");
  if (digits.length !== 11 || !secret) return null;
  return createHmac("sha256", secret).update(digits).digest("hex");
}

const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/** Clientes cujo CPF casa com o HMAC (varredura por id em lotes; exclusão é rara, então não pede coluna indexada nova). Inclui os já anonimizados (guardam nome e CPF). */
export async function findCustomersByCpfHmac(db: Db, hmac: string, secret: string, batch = 2000): Promise<number[]> {
  const found: number[] = [];
  let after = 0;
  for (;;) {
    const rows = await db.select({ id: customers.id, document: customers.documentNumber }).from(customers).where(and(gt(customers.id, after), isNotNull(customers.documentNumber))).orderBy(asc(customers.id)).limit(batch);
    for (const row of rows) { const candidate = cpfHmac(row.document, secret); if (candidate && sameHex(candidate, hmac)) found.push(row.id); }
    if (rows.length < batch) return found;
    after = rows[rows.length - 1]!.id;
  }
}

type CustomerOutcome = { kind: "anonymized" } | { kind: "already" } | { kind: "blocked"; blockers: string[] };

async function anonymizeOne(db: Db, customerId: number, now: Date): Promise<CustomerOutcome> {
  return withDeadlockRetry(() => db.transaction(async tx => {
    const [customer] = await tx.select({ id: customers.id, anonymizedAt: customers.anonymizedAt }).from(customers).where(eq(customers.id, customerId)).limit(1).for("update");
    if (!customer) return { kind: "already" as const };
    if (customer.anonymizedAt) return { kind: "already" as const };
    const sheets = await tx.select({ id: captureRecords.id }).from(captureRecords).where(eq(captureRecords.customerId, customerId)).for("update");
    const sheetIds = sheets.map(row => row.id);
    const blockers = await erasureBlockers(tx, customerId, sheetIds);
    if (blockers.length) return { kind: "blocked" as const, blockers };
    await applyCustomerAnonymization(tx, customerId, sheetIds, now);
    await txAudit(tx, { actorUserId: null, entityType: "customer", entityId: customerId, action: "anonymized", summary: `Cliente ${customerId} anonimizado por exclusão propagada do GuestPass (${sheetIds.length} ficha(s)); ficam só nome, CPF e a data do brinde.` });
    await eligibilityHook(tx, { customerId }); // C2/C3: anonimizado sai do feed. Último passo da tx.
    return { kind: "anonymized" as const };
  }));
}

/** Posse (lease) do evento enquanto uma rodada o processa; expirada, outra rodada pode retomar (processo que caiu no meio). */
export const CLAIM_LEASE_MS = 2 * 60_000;
const CLAIM_POLL_MS = 50;
const affectedRows = (result: unknown) => Number(((Array.isArray(result) ? result[0] : result) as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export type ErasureResult = { eventId: string; replay: boolean; status: "done" | "partial" | "nothing_to_erase" | "needs_human"; receipt: { system: "crm"; status: ReceiptStatus; detail: string | null } };

const decide = (input: { mode: "minimal" | "full"; keep: string[]; matched: number; anonymized: number; blocked: number; blockers: string[] }): { status: ErasureResult["status"]; receipt: ReceiptStatus; detail: string | null } => {
  if (input.mode === "full") return { status: "needs_human", receipt: "failed", detail: "modo full exige confirmação manual da administração; nada foi apagado" };
  if (input.mode === "minimal" && !["name", "cpf", "benefitDate"].every(item => input.keep.includes(item))) return { status: "needs_human", receipt: "failed", detail: "mínimo legal do pedido diverge do combinado; nada foi apagado" };
  if (!input.matched) return { status: "nothing_to_erase", receipt: "nothing_to_erase", detail: null };
  if (input.blocked && !input.anonymized) return { status: "needs_human", receipt: "failed", detail: `guarda legal: ${Array.from(new Set(input.blockers)).join(", ")}` };
  if (input.blocked) return { status: "partial", receipt: "partial", detail: `guarda legal em ${input.blocked} de ${input.matched}: ${Array.from(new Set(input.blockers)).join(", ")}` };
  if (!input.anonymized) return { status: "nothing_to_erase", receipt: "nothing_to_erase", detail: "titular já anonimizado" };
  return { status: "done", receipt: "done", detail: null };
};

/**
 * Recebe e cumpre um evento do feed. Idempotente por eventId: o segundo processamento devolve o resultado gravado e não anonimiza nada de novo. Quem chama grava o recibo no GuestPass.
 * `full` e qualquer divergência do mínimo legal NÃO apagam nada (status needs_human). Cliente com guarda legal (contrato, reserva, documento, ficha VENDEU) fica de fora.
 */
export async function processErasureEvent(db: Db, raw: unknown, options: { hmacSecret: string; now?: Date }): Promise<ErasureResult> {
  const event = erasureEventSchema.parse(raw);
  const now = options.now ?? new Date();
  const [existing] = await db.select().from(privacyErasureEvents).where(eq(privacyErasureEvents.eventId, event.eventId)).limit(1);
  if (existing?.processedAt) {
    const [receipt] = await db.select().from(privacyErasureReceipts).where(and(eq(privacyErasureReceipts.eventId, event.eventId), eq(privacyErasureReceipts.system, "crm"))).limit(1);
    return { eventId: event.eventId, replay: true, status: existing.status as ErasureResult["status"], receipt: { system: "crm", status: (receipt?.status ?? "failed") as ReceiptStatus, detail: receipt?.detail ?? null } };
  }
  if (!existing) {
    try {
      await db.transaction(async tx => {
        const [{ id }] = await tx.insert(privacyErasureEvents).values({
          eventId: event.eventId, source: "guestpass", externalRef: event.guestPassId?.slice(0, 40) ?? null, externalRequestId: event.requestId ?? null, mode: event.mode, cpfHmac: event.subjectRefs.cpfHmac,
          requestedAt: event.requestedAt ? new Date(event.requestedAt) : null, fulfilledAt: event.fulfilledAt ? new Date(event.fulfilledAt) : null,
        }).$returningId();
        // Evento INTERNO (fan-out para os outros sistemas, por contrato futuro): só o eventId e o modo, nunca CPF, nome ou HMAC.
        await txEvent(tx, { eventName: "privacy.erasure.requested", aggregateType: "privacy_erasure_event", aggregateId: id, actorUserId: null, idempotencyKey: `privacy-erasure:${event.eventId}`, payload: { eventId: event.eventId, mode: event.mode } });
        await txAudit(tx, { actorUserId: null, entityType: "privacy_erasure", entityId: id, action: "received", summary: `Pedido de exclusão propagado recebido do GuestPass (modo ${event.mode}).` });
      });
    } catch (error) { if (!isDuplicateKeyError(error)) throw error; /* corrida com outra rodada: segue e processa como replay abaixo */ }
  }

  // POSSE antes de anonimizar: sem ela, duas rodadas do mesmo eventId anonimizariam e a que viu "já anonimizado" poderia gravar nothing_to_erase (recibo dependente de escalonamento).
  // A perdedora espera a vencedora terminar e devolve o resultado gravado (replay); se a vencedora cair, o lease expira e esta retoma.
  for (;;) {
    const at = new Date();
    const claimed = affectedRows(await db.update(privacyErasureEvents).set({ claimedAt: at })
      .where(and(eq(privacyErasureEvents.eventId, event.eventId), isNull(privacyErasureEvents.processedAt), or(isNull(privacyErasureEvents.claimedAt), lt(privacyErasureEvents.claimedAt, new Date(at.getTime() - CLAIM_LEASE_MS))))));
    if (claimed === 1) break;
    const [current] = await db.select({ processedAt: privacyErasureEvents.processedAt, status: privacyErasureEvents.status }).from(privacyErasureEvents).where(eq(privacyErasureEvents.eventId, event.eventId)).limit(1);
    if (current?.processedAt) {
      const [done] = await db.select().from(privacyErasureReceipts).where(and(eq(privacyErasureReceipts.eventId, event.eventId), eq(privacyErasureReceipts.system, "crm"))).limit(1);
      return { eventId: event.eventId, replay: true, status: current.status as ErasureResult["status"], receipt: { system: "crm", status: (done?.status ?? "failed") as ReceiptStatus, detail: done?.detail ?? null } };
    }
    await sleep(CLAIM_POLL_MS);
  }

  let matched: number[] = [];
  let anonymized = 0; let blocked = 0; const blockers: string[] = [];
  try {
    const legalMinimumAgreed = ["name", "cpf", "benefitDate"].every(item => event.keep.includes(item as never));
    if (event.mode === "minimal" && legalMinimumAgreed) {
      matched = await findCustomersByCpfHmac(db, event.subjectRefs.cpfHmac, options.hmacSecret);
      for (const customerId of matched) {
        const outcome = await anonymizeOne(db, customerId, now);
        if (outcome.kind === "anonymized") anonymized++;
        else if (outcome.kind === "blocked") { blocked++; blockers.push(...outcome.blockers); }
      }
    }
  } catch (error) {
    // Falha no meio: devolve a posse para a próxima rodada retomar (anonimização é idempotente por cliente).
    await db.update(privacyErasureEvents).set({ claimedAt: null }).where(and(eq(privacyErasureEvents.eventId, event.eventId), isNull(privacyErasureEvents.processedAt))).catch(() => null);
    throw error;
  }
  const verdict = decide({ mode: event.mode, keep: event.keep, matched: matched.length, anonymized, blocked, blockers });
  const finished = verdict.status === "done" || verdict.status === "nothing_to_erase";
  await db.transaction(async tx => {
    const [row] = await tx.select({ id: privacyErasureEvents.id, processedAt: privacyErasureEvents.processedAt }).from(privacyErasureEvents).where(eq(privacyErasureEvents.eventId, event.eventId)).limit(1).for("update");
    if (!row || row.processedAt) return;
    await tx.update(privacyErasureEvents).set({ status: verdict.status, customersMatched: matched.length, customersAnonymized: anonymized, detail: verdict.detail?.slice(0, 200) ?? null, processedAt: now, claimedAt: null, ...(finished ? { cpfHmac: null } : {}) }).where(eq(privacyErasureEvents.id, row.id));
    await tx.insert(privacyErasureReceipts).values({ eventId: event.eventId, system: "crm", status: verdict.receipt, detail: verdict.detail?.slice(0, 200) ?? null, receiptAt: now }).onDuplicateKeyUpdate({ set: { eventId: event.eventId } });
    await txAudit(tx, { actorUserId: null, entityType: "privacy_erasure", entityId: row.id, action: `processed_${verdict.status}`, summary: `Exclusão propagada: ${matched.length} cliente(s) achado(s), ${anonymized} anonimizado(s), ${blocked} com guarda legal. Recibo do CRM: ${verdict.receipt}.` });
  });
  const [final] = await db.select().from(privacyErasureEvents).where(eq(privacyErasureEvents.eventId, event.eventId)).limit(1);
  const status = (final?.status ?? verdict.status) as ErasureResult["status"];
  const [receipt] = await db.select().from(privacyErasureReceipts).where(and(eq(privacyErasureReceipts.eventId, event.eventId), eq(privacyErasureReceipts.system, "crm"))).limit(1);
  return { eventId: event.eventId, replay: Boolean(existing), status, receipt: { system: "crm", status: (receipt?.status ?? verdict.receipt) as ReceiptStatus, detail: receipt?.detail ?? verdict.detail } };
}

/** Recibo de OUTRO sistema (Sales, Recovery, Relationship, Financial) que vai chegar por contrato futuro; idempotente por (eventId, system). Sem PII no detalhe. */
export async function recordSystemReceipt(db: Db, input: { eventId: string; system: Exclude<ErasureSystem, "crm">; status: ReceiptStatus; detail?: string }) {
  const [event] = await db.select({ id: privacyErasureEvents.id }).from(privacyErasureEvents).where(eq(privacyErasureEvents.eventId, input.eventId)).limit(1);
  if (!event) return { ok: false as const, error: "UNKNOWN_EVENT" as const };
  await db.insert(privacyErasureReceipts).values({ eventId: input.eventId, system: input.system, status: input.status, detail: input.detail?.slice(0, 200) ?? null }).onDuplicateKeyUpdate({ set: { status: input.status, detail: input.detail?.slice(0, 200) ?? null } });
  return { ok: true as const };
}

/** Quais sistemas ainda não deram recibo para o evento (o pedido só é "propagado" com todos). */
export async function pendingSystems(db: Db, eventId: string): Promise<ErasureSystem[]> {
  const rows = await db.select({ system: privacyErasureReceipts.system }).from(privacyErasureReceipts).where(eq(privacyErasureReceipts.eventId, eventId));
  const have = new Set(rows.map(row => row.system));
  return ERASURE_SYSTEMS.filter(system => !have.has(system));
}
