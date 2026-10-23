import { afterEach, describe, expect, it } from "vitest";
import { isCaptureVisitRuleEnabled, VISIT_RULE_MESSAGE, visitRuleViolation } from "./captureVisitRule";

describe("F1.6: ficha sem data precisa de passante explícito", () => {
  const previous = process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY;
  afterEach(() => { if (previous === undefined) delete process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY; else process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY = previous; });

  it("nasce desligada", () => {
    delete process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY;
    expect(isCaptureVisitRuleEnabled()).toBe(false);
    process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY = "false";
    expect(isCaptureVisitRuleEnabled()).toBe(false);
    process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY = "true";
    expect(isCaptureVisitRuleEnabled()).toBe(true);
  });
  it("sem data e sem passante é violação; data OU passante explícito passa", () => {
    expect(visitRuleViolation({})).toBe(VISIT_RULE_MESSAGE);
    expect(visitRuleViolation({ scheduledAt: null, isPasserby: false })).toBe(VISIT_RULE_MESSAGE);
    expect(visitRuleViolation({ scheduledAt: "  ", isPasserby: false })).toBe(VISIT_RULE_MESSAGE);
    expect(visitRuleViolation({ scheduledAt: new Date("invalid") })).toBe(VISIT_RULE_MESSAGE);
    expect(visitRuleViolation({ scheduledAt: "2026-10-23T14:00:00.000Z" })).toBeNull();
    expect(visitRuleViolation({ scheduledAt: new Date("2026-10-23T14:00:00Z"), isPasserby: false })).toBeNull();
    expect(visitRuleViolation({ scheduledAt: null, isPasserby: true })).toBeNull();
  });
});
