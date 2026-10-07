import { describe, expect, it } from "vitest";
import { canOpenMenuPath, menuPathRoles } from "../shared/permissions";

// KAN-31 (teste de navegador, crm-rbac P2): o menu mostrava telas que o servidor recusa (403) e a tela exibia R$ 0,00 ou
// "Carregando..." eterno. A tela segue a MESMA regra dos procedures principais de cada rota (routers/access.ts).
describe("menu segue o RBAC do servidor", () => {
  const cases: Array<[string, string[]]> = [
    ["/sala-de-vendas", ["admin", "seller", "service"]], // captures.receptionQueue = receptionProcedure
    ["/captacao", ["admin", "seller"]], // captures.list = salesProcedure
    ["/vendas", ["admin", "seller"]], // sales.pipeline = salesProcedure
    ["/campanhas", ["admin", "seller"]], // campaigns = salesProcedure
    ["/comissoes", ["admin", "seller", "finance"]], // commissions.overview = commissionsProcedure
    ["/financeiro", ["admin", "finance"]], // finance.* = financeProcedure
    ["/reajustes", ["admin", "finance"]], // monetaryAdjustments = financeProcedure
    ["/politicas", ["admin", "finance"]],
    ["/reservas", ["admin", "service"]], // operations reservas = serviceProcedure
    ["/equipe", ["admin"]], // team.list = adminProcedure
    ["/importar", ["admin"]],
    ["/configuracoes-projeto", ["admin"]],
  ];
  it.each(cases)("%s só para %j", (path, roles) => {
    for (const role of ["admin", "seller", "finance", "service", "user"] as const) {
      expect(canOpenMenuPath(role, path), `${role} em ${path}`).toBe(roles.includes(role));
    }
  });
  it("telas sem restrição própria abrem para todo papel interno, nunca para user", () => {
    for (const path of ["/", "/contratos", "/clientes", "/agenda", "/inteligencia", "/estoque-comercial", "/analise-de-vendas"]) {
      for (const role of ["admin", "seller", "finance", "service"] as const) expect(canOpenMenuPath(role, path)).toBe(true);
      expect(canOpenMenuPath("user", path)).toBe(false);
    }
  });
  it("sub-rota herda a regra da rota (ex.: /financeiro/x)", () => {
    expect(canOpenMenuPath("seller", "/financeiro/cobrancas")).toBe(false);
    expect(Object.keys(menuPathRoles).length).toBeGreaterThan(0);
  });
});
