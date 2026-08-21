import { describe, expect, it } from "vitest";
import { buildOperationalInsights } from "./operationalAnalytics";

describe("insights operacionais", () => {
  it("prioriza exceções reais e calcula adoção por eventos e interações", () => {
    const insights = buildOperationalInsights({ exceptions: [
      { id: 1, kind: "task", label: "Retornar tour", dueAt: new Date("2026-08-15T12:00:00Z"), status: "open" },
      { id: 2, kind: "installment", label: "Ana · CTR-001", dueAt: new Date("2026-07-20T12:00:00Z"), status: "overdue", amount: "320.00" },
      { id: 3, kind: "waitlist", label: "Bruno", dueAt: new Date("2026-08-18T12:00:00Z"), status: "offered" },
    ], eventsLast30Days: [{ actorUserId: 3 }, { actorUserId: 3 }, { actorUserId: 5 }], interactionsLast30Days: 7 }, new Date("2026-08-20T12:00:00Z"));
    expect(insights.exceptions.map(item => item.id)).toEqual(["installment-2", "task-1", "waitlist-3"]);
    expect(insights.adoption).toEqual({ eventsLast30Days: 3, activeOperators: 2, interactionsLast30Days: 7 });
  });

  it("expõe desvios de captação, proposta, comissão e distrato para ação", () => {
    const insights = buildOperationalInsights({ exceptions: [
      { id: 10, kind: "capture", label: "Casal sem agenda", dueAt: new Date("2026-08-18T12:00:00Z"), status: "captured" },
      { id: 11, kind: "opportunity", label: "Proposta #11", status: "overdue_followup" },
      { id: 12, kind: "commission", label: "Liner · CTR-12", dueAt: new Date("2026-08-19T12:00:00Z"), status: "approved" },
      { id: 13, kind: "cancellation", label: "CTR-13", status: "requested" },
    ], eventsLast30Days: [], interactionsLast30Days: 0 }, new Date("2026-08-20T12:00:00Z"));
    expect(insights.exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "capture-10", title: expect.stringContaining("Captação sem desfecho") }),
      expect.objectContaining({ id: "opportunity-11", severity: "critical" }),
      expect.objectContaining({ id: "commission-12", module: "finance" }),
      expect.objectContaining({ id: "cancellation-13", module: "governance" }),
    ]));
  });
});
