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

  it("rejection codes are machine-readable for the Sales outbox classifier", () => {
    for (const code of exportEventContract().sales.ingestRejection.codes) expect(code).toMatch(/^[A-Z0-9_]{1,64}$/);
  });
});
