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

  it("idade, tempo de relacionamento e texto livre do relacionamento nunca saem", () => {
    const secret = "Maria Souza esposa do Joao";
    for (const relationshipStatus of ["Casado", secret, `${secret} separado`, `não casado ${secret}`]) {
      for (const extra of [{ relationshipYears: 7, relationshipMonths: 3 }, { relationshipYears: 1, relationshipMonths: null }, { relationshipYears: null, relationshipMonths: null }, { relationshipYears: 0, relationshipMonths: 4 }]) {
        const out = toIntegrationNq(computeNq({ ...input, relationshipStatus, primaryAge: 47, ...extra }));
        const text = JSON.stringify(out);
        expect(text).not.toContain("Maria");
        expect(text).not.toContain("Souza");
        expect(text).not.toMatch(/47 anos|\b7 ano|\b3 meses|\b4 meses/);
        for (const criterion of out.criteria) expect(Object.keys(criterion).sort()).toEqual(["detail", "key", "status"]);
      }
    }
    const out = toIntegrationNq(computeNq({ ...input, primaryAge: 47 }));
    expect(out.criteria.find(c => c.key === "idade_homem")).toEqual({ key: "idade_homem", status: "ok", detail: "Idade do homem acima do mínimo." });
    expect(out.criteria.find(c => c.key === "relacionamento")).toEqual({ key: "relacionamento", status: "ok", detail: "Casado ou união estável." });
  });

  it("CRM-A22: todo detalhe que sai pertence a uma lista fixa (lista de permissão), em todas as combinações", () => {
    const allowed = new Set<string>();
    const ages = [null, 25, 31, 47], statuses = [null, "Casado", "Namorando", "Separado", "Maria Souza"], years = [null, 0, 1, 5], months = [null, 0, 4, 30];
    const kinds = [null, "carro", "moto", "nenhum"] as const, vyears = [null, 2010, 2020], incomes = [null, 100, 99999], flags = [null, true, false];
    for (const maleSpouse of [null, "titular", "conjuge"] as const) for (const primaryAge of ages) for (const relationshipStatus of statuses) for (const relationshipYears of years) for (const relationshipMonths of months) for (const vehicleKind of kinds) for (const vehicleYear of vyears) for (const averageIncome of incomes) for (const hasCreditCard of flags) {
      const out = toIntegrationNq(computeNq({ maleSpouse, primaryAge, partnerAge: primaryAge, relationshipStatus, relationshipYears, relationshipMonths, vehicleKind, vehicleYear, secondVehicleKind: vehicleKind, secondVehicleYear: vehicleYear, averageIncome, hasCreditCard, ownsHome: hasCreditCard }));
      for (const c of out.criteria) allowed.add(`${c.key}|${c.status}|${c.detail}`);
    }
    // Poucas frases por critério e status; nada com dígito (idade, anos, meses, renda) nem com o texto livre.
    for (const entry of allowed) {
      expect(entry).not.toMatch(/\d/);
      expect(entry).not.toMatch(/Maria|Souza|Namorando|Separado/);
    }
    expect(allowed.size).toBeLessThan(40);
  });

  it("critério desconhecido sai com frase genérica, nunca com o texto do cálculo", () => {
    const nq = computeNq(input);
    const leaky = { ...nq, criteria: [...nq.criteria, { key: "futuro" as never, label: "x", status: "ok" as const, detail: "CPF 123.456.789-09 de Maria" }] };
    const out = toIntegrationNq(leaky);
    expect(JSON.stringify(out)).not.toMatch(/123\.456|Maria/);
    expect(out.criteria.at(-1)).toEqual({ key: "futuro", status: "ok", detail: "Critério atendido." });
  });
});
