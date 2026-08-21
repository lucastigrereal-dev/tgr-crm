export type CommercialRole = "promoter" | "qualifier" | "liner" | "closer" | "ftb" | "room_manager" | "finance";

export type ProfessionalSaleFact = {
  saleId: number;
  userId: number;
  role: CommercialRole;
  vgvFormalized: number;
  cashConfirmed: number;
  lifecycle: "new" | "matured" | "cancelled";
  attendance?: "scheduled" | "checked_in" | "no_tour" | "closed";
};

export type ProfessionalScorecard = {
  userId: number;
  role: CommercialRole;
  attributedSales: number;
  vgvFormalized: number;
  cashConfirmed: number;
  maturedSales: number;
  cancelledMaturedSales: number;
  cancellationRate: number | null;
  coverage: "insufficient" | "maturing" | "mature";
};

function keyOf(fact: ProfessionalSaleFact) { return `${fact.saleId}:${fact.userId}:${fact.role}`; }

/**
 * FTB é crédito exclusivo quando a mesma pessoa aparece como liner/closer no mesmo negócio.
 * A função só agrega fatos já atribuídos e não infere desempenho a partir de perfil pessoal.
 */
export function buildProfessionalScorecards(facts: ProfessionalSaleFact[], minimumMaturedSales = 10): ProfessionalScorecard[] {
  const ftbAssignments = new Set(facts.filter(fact => fact.role === "ftb").map(fact => `${fact.saleId}:${fact.userId}`));
  const unique = new Map<string, ProfessionalSaleFact>();
  for (const fact of facts) {
    if (["liner", "closer"].includes(fact.role) && ftbAssignments.has(`${fact.saleId}:${fact.userId}`)) continue;
    unique.set(keyOf(fact), fact);
  }
  const groups = new Map<string, ProfessionalSaleFact[]>();
  for (const fact of Array.from(unique.values())) {
    const key = `${fact.userId}:${fact.role}`;
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map(group => {
    const matured = group.filter(fact => fact.lifecycle === "matured" || fact.lifecycle === "cancelled");
    const cancelledMaturedSales = matured.filter(fact => fact.lifecycle === "cancelled").length;
    const coverage: ProfessionalScorecard["coverage"] = matured.length >= minimumMaturedSales ? "mature" : matured.length ? "maturing" : "insufficient";
    return {
      userId: group[0]!.userId,
      role: group[0]!.role,
      attributedSales: group.length,
      vgvFormalized: Number(group.reduce((sum, fact) => sum + fact.vgvFormalized, 0).toFixed(2)),
      cashConfirmed: Number(group.reduce((sum, fact) => sum + fact.cashConfirmed, 0).toFixed(2)),
      maturedSales: matured.length,
      cancelledMaturedSales,
      cancellationRate: matured.length ? Number((cancelledMaturedSales / matured.length * 100).toFixed(2)) : null,
      coverage,
    };
  }).sort((left, right) => right.cashConfirmed - left.cashConfirmed || right.vgvFormalized - left.vgvFormalized);
}
