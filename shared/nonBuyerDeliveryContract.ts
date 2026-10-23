import { z } from "zod";

// F2.1: corpo de ENTREGA CRM -> Recovery (crm.non_buyer.eligible.v1 / crm.non_buyer.eligibility_revoked.v1). PROPOSTA de contrato (aditiva): NÃO entra em tgr-events.snapshot.json
// nem em consumers.lock.json e não altera nenhuma fixture publicada; a Suite é dona do contrato (Suite -> CRM -> re-pin). Fixture: docs/contracts/fixtures/crm.non_buyer.v1.fixtures.json. Dados sintéticos.
const control = /[\u0000-\u001f\u007f]/;
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !control.test(value), "control characters");
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const REVOKED_REASONS = ["opt_out", "anonymized", "erasure", "sale_in_progress", "attendance_not_finished"] as const;

export const eligibleBodySchema = z.strictObject({
  eventId: z.string().regex(/^crm-nb-\d+-eligible-\d+$/).max(120),
  source: z.literal("crm"),
  occurredAt: utc,
  project: z.strictObject({ externalKey: text(120), name: text(180), timezone: text(64) }),
  coupleCode: text(64),
  coupleId: text(80),
  encounterDate: day,
  dedupeKey: text(140),
  eligibleAt: utc,
  lastEncounterAt: utc,
  branch: z.enum(["closed", "no_tour"]),
  reasonCode: text(60).nullable(),
  consentVersion: text(40).nullable(),
  channels: z.array(z.enum(["whatsapp", "phone", "sms", "email"])).max(4),
  contact: z.strictObject({ name: text(255), phone: text(32).nullable() }),
}).refine(body => body.dedupeKey === `${body.coupleCode}:${body.encounterDate}`, { message: "dedupeKey must be coupleCode:encounterDate" });

export const revokedBodySchema = z.strictObject({
  eventId: z.string().regex(/^crm-nb-\d+-revoked-\d+$/).max(120),
  source: z.literal("crm"),
  coupleCode: text(64),
  encounterDate: day,
  dedupeKey: text(140),
  revokedAt: utc,
  reason: z.enum(REVOKED_REASONS),
}).refine(body => body.dedupeKey === `${body.coupleCode}:${body.encounterDate}`, { message: "dedupeKey must be coupleCode:encounterDate" });
