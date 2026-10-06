import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportEventContract } from "./eventContract";

// WP5: o snapshot que os consumidores copiam tem de ser exatamente o que o código do CRM emite hoje.
const snapshot = JSON.parse(readFileSync(path.join(__dirname, "../shared/contracts/tgr-events.snapshot.json"), "utf8"));

describe("CRM event contract export", () => {
  it("committed snapshot matches what the bridges build (regenerate with scripts/export-event-contract.ts)", () => {
    expect(JSON.parse(JSON.stringify(exportEventContract()))).toEqual(snapshot);
  });

  it("every sale-linked body carries saleId, and Sales never receives customer PII", () => {
    const contract = exportEventContract();
    for (const body of [...contract.relationship.sampleBodies, contract.sales.cancellationSampleBody]) expect(body.saleId).toMatch(/\S/);
    expect(contract.sales.cancellationSampleBody).not.toHaveProperty("customer");
    expect(contract.financial.sampleEnvelope.event.payload).toHaveProperty("saleId");
  });

  it("ADR-007: crm.sale.validated.v1 to Sales has no PII; Financial sale.* samples carry only whitelisted fields", () => {
    const { sales, financial } = exportEventContract();
    expect(Object.keys(sales.saleValidatedSampleBody).sort()).toEqual(["contractId", "correlationId", "eventId", "eventName", "gates", "occurredAt", "project", "saleId", "source", "validatedAt", "validatedBy"]);
    expect(Object.keys(sales.saleValidatedSampleBody.gates).sort()).toEqual(["contractGeneratedAt", "contractSignedAt", "documentRef", "documentStoredAt", "paymentConfirmedAt", "paymentConfirmedBy"]);
    expect(JSON.stringify(sales.saleValidatedSampleBody)).not.toMatch(/customer|phone|\.pdf|storageKey/i);
    // KAN-31 V6: payload ESTRITO do Financial (z.strictObject): exatamente estes quatro campos, contractId como texto.
    expect(financial.saleValidatedSampleEnvelope.event.payload).toEqual({ contractId: "9001", saleId: expect.any(String), validatedAt: "2026-10-05T12:00:00.000Z", validatedBy: "1" });
    expect(financial.forwardedEventNames).not.toContain("sale.payment.confirmed");
    expect(financial.forwardedEventNames).toEqual(expect.arrayContaining(["sale.validated"]));
  });

  it("rejection codes are machine-readable for the Sales outbox classifier", () => {
    const { ingestRejection, ingestTransientFailure } = exportEventContract().sales;
    for (const code of ingestRejection.codes ?? []) expect(code).toMatch(/^[A-Z0-9_]{1,64}$/);
    expect(ingestRejection).toMatchObject({ status: 422, body: { accepted: false, code: "INSUFFICIENT_INVENTORY" } });
    // Falha transitória: 503 genérico, nunca a mensagem interna.
    expect(ingestTransientFailure).toEqual({ status: 503, body: { accepted: false, code: "EVENT_PROCESSING_FAILED", error: "Event processing failed" } });
  });

  it("export targets are the delivery targets themselves (no copy that can drift, e.g. PII to Sales)", async () => {
    const { CONTRACT_STATE_TARGETS } = await import("./relationshipBridge");
    expect(CONTRACT_STATE_TARGETS.salesCancellation.includeCustomer).toBe(false);
    expect(CONTRACT_STATE_TARGETS.salesCancellation.label).toBe("Sales Command");
    expect(CONTRACT_STATE_TARGETS.relationship.label).toBe("Relationship");
  });
});
