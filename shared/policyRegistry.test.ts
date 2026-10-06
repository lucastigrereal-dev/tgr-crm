import { describe, expect, it } from "vitest";
import { checkPolicyTransition, OPEN_POLICY_TYPES } from "./policyRegistry";

describe("policy registry transitions (WP11)", () => {
  it("lists exactly the 8 open policy types of PRD §13", () => {
    expect(OPEN_POLICY_TYPES).toHaveLength(8);
  });

  it("APPROVED needs a named approver AND a receipt reference", () => {
    expect(checkPolicyTransition("UNAPPROVED", "APPROVED", {})).toMatchObject({ ok: false, code: "APPROVAL_EVIDENCE_REQUIRED" });
    expect(checkPolicyTransition("UNAPPROVED", "APPROVED", { approver: "SYN Jurídico" })).toMatchObject({ ok: false, code: "APPROVAL_EVIDENCE_REQUIRED" });
    expect(checkPolicyTransition("UNAPPROVED", "APPROVED", { approver: "  ", receiptRef: "doc-1" })).toMatchObject({ ok: false });
    expect(checkPolicyTransition("UNAPPROVED", "APPROVED", { approver: "SYN Jurídico", receiptRef: "SYN-doc-1" })).toEqual({ ok: true });
  });

  it("DRAFT cannot jump to APPROVED, RETIRED is terminal, APPROVED only retires", () => {
    expect(checkPolicyTransition("DRAFT", "APPROVED", { approver: "x", receiptRef: "y" })).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    for (const to of ["DRAFT", "UNAPPROVED", "APPROVED"] as const) expect(checkPolicyTransition("RETIRED", to, { approver: "x", receiptRef: "y" }).ok).toBe(false);
    expect(checkPolicyTransition("APPROVED", "UNAPPROVED", {}).ok).toBe(false);
    expect(checkPolicyTransition("APPROVED", "RETIRED", {}).ok).toBe(true);
    expect(checkPolicyTransition("DRAFT", "UNAPPROVED", {}).ok).toBe(true);
  });
});
