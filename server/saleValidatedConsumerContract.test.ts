import { describe, expect, it } from "vitest";
import { z } from "zod";
import { financialBridgeEnvelope } from "./financialBridge";
import { buildSaleValidatedBody, saleValidatedFactsFrom, type ContractLineage } from "./relationshipBridge";
import { saleDocumentRef } from "./saleValidation";

// KAN-31 V6: contrato do CONSUMIDOR, copiado das regras que a suite já aplica (tgr-commercial-suite,
// branch claude/tgr-core-v6-final-7mvbjm):
//  - Sales: apps/sales-command/server/src/modules/integration/crm-sale-validation-intake.ts (parseCrmSaleValidated)
//  - Financial: apps/financial-layer/server/src/service.ts (saleValidatedPayloadSchema, z.strictObject)
// Se a suite mudar a regra, este teste é o lugar de mudar junto. Dados 100% sintéticos.

const OPAQUE_ACTOR_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const instant = z.string().datetime({ offset: true });
const opaqueUser = z.union([z.string(), z.number().int().nonnegative()]).transform(value => String(value).trim()).pipe(z.string().regex(OPAQUE_ACTOR_ID));
function documentRefLooksUnsafe(value: string) {
  if (value.length < 1 || value.length > 200) return true;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return true;
  if (value.includes("://") || /[@?]/.test(value)) return true;
  return /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(value);
}
const salesEnvelope = z.object({
  eventId: z.string().trim().min(1).max(160),
  eventName: z.literal("crm.sale.validated.v1"),
  source: z.literal("crm"),
  correlationId: z.string().trim().min(1).max(128),
  occurredAt: z.string().datetime({ offset: true }),
  project: z.object({ externalKey: z.string().uuid() }).passthrough(),
  saleId: z.string().uuid(),
  contractId: z.string().trim().min(1).max(120),
}).passthrough();
const salesGates = z.object({
  validatedAt: instant,
  validatedBy: opaqueUser,
  gates: z.object({
    paymentConfirmedAt: instant, paymentConfirmedBy: opaqueUser, contractGeneratedAt: instant, contractSignedAt: instant, documentStoredAt: instant,
    documentRef: z.string().trim().refine(value => !documentRefLooksUnsafe(value)),
  }),
});
function salesAccepts(body: unknown, now = new Date()) {
  if (!salesEnvelope.safeParse(body).success) return { ok: false, status: 400 };
  const parsed = salesGates.safeParse(body);
  if (!parsed.success) return { ok: false, status: 422, code: "SALE_VALIDATION_GATES_INCOMPLETE" };
  const validated = Date.parse(parsed.data.validatedAt);
  const stamps = [parsed.data.gates.paymentConfirmedAt, parsed.data.gates.contractGeneratedAt, parsed.data.gates.contractSignedAt, parsed.data.gates.documentStoredAt].map(Date.parse);
  const all = [Date.parse((body as { occurredAt: string }).occurredAt), validated, ...stamps];
  if (all.some(stamp => !Number.isFinite(stamp) || stamp < Date.UTC(2000, 0, 1) || stamp > now.getTime() + 86_400_000)) return { ok: false, status: 422, code: "SALE_VALIDATION_GATES_INCOMPLETE" };
  if (stamps.some(stamp => stamp > validated)) return { ok: false, status: 422, code: "SALE_VALIDATION_GATES_INCOMPLETE" };
  return { ok: true, status: 201 };
}
const financialSaleValidated = z.strictObject({
  contractId: z.string().trim().min(1).max(128),
  saleId: z.string().trim().min(1).max(128),
  validatedAt: z.string().datetime({ offset: true }),
  validatedBy: z.union([z.string(), z.number().int().nonnegative()]).transform(value => String(value).trim()).pipe(z.string().regex(OPAQUE_ACTOR_ID)),
});

// UUIDs v4 válidos: o zod 4 da suite exige versão/variante RFC (ids reais do Sales vêm de randomUUID).
const lineage: ContractLineage = {
  saleId: "44444444-4444-4444-8444-444444444444", projectExternalKey: "22222222-2222-4222-8222-222222222222", projectName: "SYN Resort",
  projectTimezone: "America/Recife", correlationId: "corr-sale-1", customerId: 101, customerName: "Ana & Bruno", customerPhone: "84999990000", cancellationReason: null,
};
// Payload do domain event sale.validated como o saleValidationService grava.
const domainPayload = {
  contractId: 303, saleId: lineage.saleId,
  validatedAt: "2026-10-06T12:00:00.000Z", validatedByUserId: 7, validatedBy: "7",
  paymentConfirmedAt: "2026-10-05T12:00:00.000Z", paymentConfirmedByUserId: 7, paymentConfirmedBy: "7",
  contractGeneratedAt: "2026-10-04T12:00:00.000Z", contractSignedAt: "2026-10-05T18:00:00.000Z",
  documentStoredAt: "2026-10-05T18:05:00.000Z", documentRef: saleDocumentRef(303, 55),
};
const at = new Date("2026-10-06T12:00:01.000Z");

describe("crm.sale.validated.v1 → Sales (regras do receptor da suite)", () => {
  it("o corpo que o CRM monta é aceito pelo parser do Sales (201, não 422)", () => {
    const facts = saleValidatedFactsFrom(domainPayload);
    expect(facts).not.toBeNull();
    const body = buildSaleValidatedBody(lineage, 303, at, facts!);
    expect(salesAccepts(body, new Date("2026-10-06T13:00:00.000Z"))).toEqual({ ok: true, status: 201 });
    expect(body).toMatchObject({
      eventId: "crm-sale-303-validated", eventName: "crm.sale.validated.v1", source: "crm", saleId: lineage.saleId, contractId: "303",
      project: { externalKey: lineage.projectExternalKey }, validatedAt: domainPayload.validatedAt, validatedBy: "7",
      gates: {
        paymentConfirmedAt: domainPayload.paymentConfirmedAt, paymentConfirmedBy: "7", contractGeneratedAt: domainPayload.contractGeneratedAt,
        contractSignedAt: domainPayload.contractSignedAt, documentStoredAt: domainPayload.documentStoredAt, documentRef: "crm-doc:303:55",
      },
    });
  });

  it("documentRef é opaco: passa na checagem do Sales e não carrega URL, e-mail, query, espaço, CPF nem nome de arquivo", () => {
    for (const [contractId, documentId] of [[1, 1], [303, 55], [2_147_483_647, 2_147_483_647]] as const) {
      const ref = saleDocumentRef(contractId, documentId);
      expect(documentRefLooksUnsafe(ref)).toBe(false);
      expect(ref).toMatch(/^crm-doc:\d+:\d+$/);
    }
  });

  it("sem PII do cliente no corpo do Sales", () => {
    const text = JSON.stringify(buildSaleValidatedBody(lineage, 303, at, saleValidatedFactsFrom(domainPayload)!));
    for (const forbidden of ["customer", "Ana", "84999990000", "phone", ".pdf", "storageKey"]) expect(text).not.toContain(forbidden);
  });

  it("payload sem qualquer portão (ou com portão depois da validação) não vira corpo: nada que o Sales recusaria sai do CRM", () => {
    for (const key of ["validatedBy", "paymentConfirmedBy", "contractGeneratedAt", "contractSignedAt", "documentStoredAt", "documentRef", "paymentConfirmedAt", "validatedAt"]) {
      expect(saleValidatedFactsFrom({ ...domainPayload, [key]: undefined })).toBeNull();
    }
    expect(saleValidatedFactsFrom({ ...domainPayload, contractSignedAt: "2026-10-07T00:00:00.000Z" })).toBeNull();
    expect(saleValidatedFactsFrom({ ...domainPayload, documentRef: "https://bucket/x.pdf?token=1" })).toBeNull();
    expect(saleValidatedFactsFrom({ ...domainPayload, validatedBy: "gerente@tgr.com" })).toBeNull();
  });
});

describe("sale.validated → Financial (payload ESTRITO da suite)", () => {
  const envelope = () => financialBridgeEnvelope({ id: 4243, eventName: "sale.validated", aggregateType: "contract", aggregateId: "303", actorUserId: 7, occurredAt: at, payload: JSON.stringify({ ...domainPayload, internalNote: "nunca sai" }) }, { externalKey: lineage.projectExternalKey, name: "SYN Resort", timezone: "America/Recife" });

  it("payload é exatamente {contractId, saleId, validatedAt, validatedBy} e passa no z.strictObject do Financial", () => {
    const { payload } = envelope().event;
    expect(payload).toEqual({ contractId: "303", saleId: lineage.saleId, validatedAt: domainPayload.validatedAt, validatedBy: "7" });
    expect(financialSaleValidated.safeParse(payload).success).toBe(true);
  });
});
