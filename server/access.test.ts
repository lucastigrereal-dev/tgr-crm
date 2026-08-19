import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function contextFor(role: "user" | "admin" | "seller" | "finance" | "service"): TrpcContext {
  return {
    user: { id: 99, openId: `test-${role}`, email: `${role}@example.com`, name: role, loginMethod: "test", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => undefined } as TrpcContext["res"],
  };
}

describe("perfis internos", () => {
  it("bloqueia usuário sem perfil operacional no CRM, agenda e contratos", async () => {
    const caller = appRouter.createCaller(contextFor("user"));
    await expect(caller.customers.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.operations.tasks()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.contracts.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bloqueia vendedor no financeiro e na operação de reservas", async () => {
    const caller = appRouter.createCaller(contextFor("seller"));
    await expect(caller.finance.entries()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.operations.reservations()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bloqueia atendimento do funil comercial", async () => {
    const caller = appRouter.createCaller(contextFor("service"));
    await expect(caller.sales.pipeline()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.commissions.overview()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("deixa a prévia CSV exclusivamente nas mãos da administração", async () => {
    const admin = appRouter.createCaller(contextFor("admin"));
    const seller = appRouter.createCaller(contextFor("seller"));
    const csv = "nome_completo;documento\nAna da Silva;12345678900";
    await expect(admin.imports.preview({ kind: "customers", csv })).resolves.toMatchObject({ valid: true, totalRows: 1, summary: { processed: 1, rejected: 0, issuesByField: [] } });
    await expect(seller.imports.preview({ kind: "customers", csv })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.imports.commit({ kind: "customers", csv: "nome_completo;documento\nA;" })).resolves.toMatchObject({ committed: false, summary: { processed: 1, rejected: 1 } });
    await expect(admin.imports.suggestMapping({ kind: "customers", csv: "Nome;CPF\nAna da Silva;12345678900" })).resolves.toMatchObject({ suggestedMapping: { nome_completo: "Nome", documento: "CPF" } });
    await expect(admin.imports.errorReport({ kind: "customers", csv: "nome_completo;documento\nA;" })).resolves.toMatchObject({ filename: "erros-importacao-customers.csv", totalIssues: 2 });
    await expect(seller.imports.errorReport({ kind: "customers", csv })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(seller.imports.undoLast({ confirm: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("permite os caminhos operacionais compatíveis para cada perfil", async () => {
    const service = appRouter.createCaller(contextFor("service"));
    const seller = appRouter.createCaller(contextFor("seller"));
    const finance = appRouter.createCaller(contextFor("finance"));
    await expect(service.customers.list()).resolves.toBeInstanceOf(Array);
    await expect(service.operations.reservations()).resolves.toBeInstanceOf(Array);
    await expect(seller.sales.pipeline()).resolves.toBeInstanceOf(Array);
    await expect(finance.contracts.list()).resolves.toBeInstanceOf(Array);
    await expect(finance.finance.entries()).resolves.toBeInstanceOf(Array);
    await expect(finance.dashboard.summary()).resolves.toMatchObject({ activeContracts: expect.any(Number) });
    await expect(finance.dashboard.commercialCharts()).resolves.toMatchObject({ funnel: expect.any(Array), goals: expect.any(Array) });
    await expect(finance.dashboard.funnelDetails({ stage: "proposal" })).resolves.toBeInstanceOf(Array);
    await expect(finance.commissions.overview()).resolves.toMatchObject({ campaigns: expect.any(Array), ranking: expect.any(Array), entries: expect.any(Array) });
  });
});
