import { describe, expect, it } from "vitest";
import { commissionBlockReason } from "./installmentCommissions";
import { evaluateProjectReadiness, commissionPolicyGaps, type ReadinessInput } from "./projectPolicyReadiness";
import { parseCompleteCommissionPolicy } from "./projectPolicy";

const COMPLETE = JSON.stringify({ linerRate: 0.02, closerRate: 0.03, ftbRate: 0.01, cancellationDeadlineDay: 7, expectedPaymentDay: 10, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt" });

describe("F1.12: lacunas da política de comissão V1", () => {
  it("política completa não tem lacuna; as incompletas dizem o que falta", () => {
    expect(commissionPolicyGaps(COMPLETE)).toEqual([]);
    expect(commissionPolicyGaps(null)).toEqual(["política de comissão não cadastrada"]);
    expect(commissionPolicyGaps("   ")).toEqual(["política de comissão não cadastrada"]);
    expect(commissionPolicyGaps("{nao é json")).toEqual(["JSON ilegível"]);
    expect(commissionPolicyGaps("[]")).toEqual(["JSON deve ser um objeto"]);
    // O exemplo que a tela de regras mostra (só percentuais) NÃO basta: foi o que bloqueou a comissão na homologação.
    const onlyRates = commissionPolicyGaps(JSON.stringify({ linerRate: 0.02, closerRate: 0.03, ftbRate: 0.04 }));
    expect(onlyRates).toEqual(expect.arrayContaining(["dia do prazo de cancelamento", "dia previsto do pagamento", "formas de pagamento elegíveis", "base de cálculo (eligible_receipt)"]));
    expect(commissionPolicyGaps(JSON.stringify({ ...JSON.parse(COMPLETE), eligiblePaymentMethods: [] }))).toEqual(["formas de pagamento elegíveis"]);
    expect(commissionPolicyGaps(JSON.stringify({ ...JSON.parse(COMPLETE), mistyped: 1 }))[0]).toMatch(/desconhecido/);
  });

  it("o checklist concorda com o motor: completo aqui = não bloqueia lá; incompleto aqui = incomplete_project_policy lá", () => {
    const samples = [COMPLETE, JSON.stringify({ linerRate: 0.02 }), "{}", "lixo", JSON.stringify({ ...JSON.parse(COMPLETE), basis: "outra" }), JSON.stringify({ ...JSON.parse(COMPLETE), cancellationDeadlineDay: 40 })];
    for (const raw of samples) {
      const engine = commissionBlockReason("active", parseCompleteCommissionPolicy(raw), true);
      expect(commissionPolicyGaps(raw).length === 0, raw).toBe(engine === null);
      if (engine) expect(engine).toBe("incomplete_project_policy");
    }
  });
});

const base = (patch: Partial<ReadinessInput> = {}): ReadinessInput => ({
  resort: { id: 1, name: "Projeto Teste", externalKey: "proj-1" },
  commission: { source: "legacy", complete: true, gaps: [], allRatesZero: false },
  settings: { cancellationPolicy: JSON.stringify({ penaltyRate: 0.1, penaltyBase: "paid", refundMode: "after_penalty" }), requiredContractDocuments: JSON.stringify(["Contrato assinado", "RG / CPF"]) },
  saleTerms: "ok", availableFractions: 10, ...patch,
});

describe("F1.12: checklist de política do projeto antes do 1º dia", () => {
  it("tudo configurado = pronto, sem bloqueio nem aviso", () => {
    const result = evaluateProjectReadiness(base());
    expect(result).toMatchObject({ ready: true, blocking: 0, warnings: 0 });
    expect(result.checks).toHaveLength(7);
  });

  it("política de comissão incompleta BLOQUEIA com o mesmo código do motor (incomplete_project_policy) e lista o que falta", () => {
    const result = evaluateProjectReadiness(base({ commission: { source: "none", complete: false, gaps: ["dia do prazo de cancelamento"], allRatesZero: false } }));
    expect(result.ready).toBe(false);
    const check = result.checks.find(item => item.key === "commission_policy")!;
    expect(check).toMatchObject({ severity: "blocking", ok: false, code: "incomplete_project_policy" });
    expect(check.detail).toContain("dia do prazo de cancelamento");
  });

  it.each([["missing", "SALE_TERMS_POLICY_MISSING"], ["ambiguous", "SALE_TERMS_POLICY_AMBIGUOUS"], ["invalid", "SALE_TERMS_POLICY_INVALID"]] as const)("condições da venda %s bloqueiam (%s)", (state, code) => {
    const result = evaluateProjectReadiness(base({ saleTerms: state }));
    expect(result.ready).toBe(false);
    expect(result.checks.find(item => item.key === "sale_terms_policy")).toMatchObject({ severity: "blocking", ok: false, code });
  });

  it("distrato, documentos, estoque, chave do projeto e percentuais em 0% só avisam: não travam o dia 1", () => {
    const result = evaluateProjectReadiness(base({ settings: null, availableFractions: 0, resort: { id: 1, name: "P", externalKey: null }, commission: { source: "legacy", complete: true, gaps: [], allRatesZero: true } }));
    expect(result.ready).toBe(true);
    expect(result.blocking).toBe(0);
    expect(result.warnings).toBe(5);
    expect(result.checks.filter(item => !item.ok).map(item => item.key).sort()).toEqual(["cancellation_policy", "commission_rates", "contract_documents", "inventory", "project_mapping"]);
  });

  it("sem política de comissão o aviso de 0% não aparece duplicado (depende da política completa)", () => {
    const result = evaluateProjectReadiness(base({ commission: { source: "none", complete: false, gaps: ["x"], allRatesZero: false } }));
    expect(result.checks.find(item => item.key === "commission_rates")!.ok).toBe(true);
  });
});
