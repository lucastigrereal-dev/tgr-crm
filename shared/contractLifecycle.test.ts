import { describe, expect, it } from "vitest";
import { canTransitionContractStatus, getAllowedContractTransitions } from "./contractLifecycle";

describe("contract lifecycle", () => {
  it("permite o fluxo normal de assinatura, ativação e encerramento", () => {
    expect(canTransitionContractStatus("draft", "pending_signature")).toBe(true);
    expect(canTransitionContractStatus("pending_signature", "active")).toBe(true);
    expect(canTransitionContractStatus("active", "closed")).toBe(true);
  });

  it("permite idempotência do mesmo status", () => {
    expect(canTransitionContractStatus("active", "active")).toBe(true);
  });

  it("bloqueia saltos e estados terminais", () => {
    expect(canTransitionContractStatus("draft", "closed")).toBe(false);
    expect(canTransitionContractStatus("cancelled", "active")).toBe(false);
    expect(canTransitionContractStatus("closed", "cancelled")).toBe(false);
    expect(getAllowedContractTransitions("cancelled")).toEqual([]);
  });
});
