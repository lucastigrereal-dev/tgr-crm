import { describe, expect, it } from "vitest";
import { canTransitionOpportunityStage, getAllowedOpportunityTransitions } from "./opportunityLifecycle";

describe("opportunity lifecycle", () => {
  it("permite avanço comercial normal", () => {
    expect(canTransitionOpportunityStage("new", "qualified")).toBe(true);
    expect(canTransitionOpportunityStage("qualified", "proposal")).toBe(true);
    expect(canTransitionOpportunityStage("proposal", "negotiation")).toBe(true);
    expect(canTransitionOpportunityStage("negotiation", "won")).toBe(true);
  });

  it("permite repetir a mesma etapa", () => {
    expect(canTransitionOpportunityStage("proposal", "proposal")).toBe(true);
  });

  it("bloqueia retorno de estados terminais e saltos incoerentes", () => {
    expect(canTransitionOpportunityStage("won", "negotiation")).toBe(false);
    expect(canTransitionOpportunityStage("lost", "proposal")).toBe(false);
    expect(canTransitionOpportunityStage("new", "won")).toBe(false);
    expect(getAllowedOpportunityTransitions("won")).toEqual([]);
  });
});
