import { describe, expect, it } from "vitest";
import { resolveBridgeConfig, type BridgeEnv } from "./bridgeConfig";

const blank: BridgeEnv = {
  relationshipEndpoint: "", relationshipCrmIntegrationKey: "",
  salesCommandEndpoint: "", salesCommandCancellationKey: "",
  financialEndpoint: "", financialCrmIntegrationKey: "",
  financialProjectExternalKey: "", financialProjectName: "", financialProjectTimezone: "America/Recife",
};

describe("pontes de saída do CRM (P-05, piloto sem Financial)", () => {
  it("tudo vazio: nenhuma ponte liga e o boot segue (cenário do piloto)", () => {
    expect(resolveBridgeConfig(blank)).toEqual({ relationship: null, salesCancellation: null, financial: null });
  });

  it("espaços em branco contam como vazio", () => {
    expect(resolveBridgeConfig({ ...blank, financialEndpoint: "  ", financialCrmIntegrationKey: " \t" }).financial).toBeNull();
  });

  it("Financial desligado não exige identidade de projeto, mesmo com as outras pontes ligadas", () => {
    const config = resolveBridgeConfig({ ...blank, relationshipEndpoint: "https://rel.test", relationshipCrmIntegrationKey: "k1", salesCommandEndpoint: "https://sales.test", salesCommandCancellationKey: "k2" });
    expect(config.relationship).toEqual({ endpoint: "https://rel.test", key: "k1" });
    expect(config.salesCancellation).toEqual({ endpoint: "https://sales.test", key: "k2" });
    expect(config.financial).toBeNull();
  });

  it("Financial ligado exige chave e identidade completa do projeto", () => {
    expect(() => resolveBridgeConfig({ ...blank, financialEndpoint: "https://fin.test" })).toThrow("Financial bridge configuration incomplete");
    expect(() => resolveBridgeConfig({ ...blank, financialCrmIntegrationKey: "k" })).toThrow("Financial bridge configuration incomplete");
    expect(() => resolveBridgeConfig({ ...blank, financialEndpoint: "https://fin.test", financialCrmIntegrationKey: "k" })).toThrow("Financial project identity incomplete");
    expect(() => resolveBridgeConfig({ ...blank, financialEndpoint: "https://fin.test", financialCrmIntegrationKey: "k", financialProjectExternalKey: "p", financialProjectName: "P", financialProjectTimezone: " " })).toThrow("Financial project identity incomplete");
    const ok = resolveBridgeConfig({ ...blank, financialEndpoint: " https://fin.test ", financialCrmIntegrationKey: " k ", financialProjectExternalKey: "p", financialProjectName: "P" });
    expect(ok.financial).toEqual({ endpoint: "https://fin.test", key: "k", project: { externalKey: "p", name: "P", timezone: "America/Recife" } });
  });

  it("Relationship e Sales Command também recusam meia configuração", () => {
    expect(() => resolveBridgeConfig({ ...blank, relationshipEndpoint: "https://rel.test" })).toThrow("Relationship bridge configuration incomplete");
    expect(() => resolveBridgeConfig({ ...blank, salesCommandCancellationKey: "k" })).toThrow("Sales Command cancellation bridge configuration incomplete");
  });
});
