import { describe, expect, it } from "vitest";
import { computeNq } from "./captureSheetDomain";
import { toIntegrationNq } from "./nqReadEndpoint";

const input = { maleSpouse: "titular" as const, primaryAge: 40, relationshipStatus: "Casado", relationshipYears: 5, relationshipMonths: 0, vehicleKind: "carro" as const, vehicleYear: 2020, averageIncome: 12345.67, hasCreditCard: true, ownsHome: true };

describe("NQ para o Sales: o que sai", () => {
  it("mantém o cálculo e tira o valor da renda do detalhe", () => {
    const nq = computeNq(input);
    expect(nq.criteria.find(c => c.key === "renda")!.detail).toContain("12.345");
    const out = toIntegrationNq(nq);
    expect(out).toMatchObject({ nqItems: 0, missing: 0, outcome: "qualificado", label: "NQ: 0 itens" });
    expect(out.criteria.find(c => c.key === "renda")).toEqual({ key: "renda", status: "ok", detail: "Renda dentro do mínimo." });
    expect(JSON.stringify(out)).not.toMatch(/12[.,]?345/);
    expect(Object.keys(out.criteria[0]!).sort()).toEqual(["detail", "key", "status"]);
  });

  it("renda abaixo do mínimo e renda faltando", () => {
    const low = toIntegrationNq(computeNq({ ...input, averageIncome: 1000 }));
    expect(low.criteria.find(c => c.key === "renda")).toEqual({ key: "renda", status: "nq", detail: "Renda abaixo do mínimo." });
    expect(JSON.stringify(low)).not.toContain("1.000");
    const missing = toIntegrationNq(computeNq({ ...input, averageIncome: null }));
    expect(missing.criteria.find(c => c.key === "renda")).toMatchObject({ status: "missing", detail: "Renda não informada." });
  });
});
