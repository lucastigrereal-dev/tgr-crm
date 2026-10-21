import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlockedItems, FlagsPanel, HistoryList, IndicatorsPanel, PermissionsPanel, RoleMapPanel, StateNotice } from "../client/src/components/crm/companySettings/panels";
import { BLOCKED_ITEMS, describeBackendState, flagHistory, indicatorHistory, permissionHistory, roleMapHistory } from "../client/src/components/crm/companySettings/text";
import { canOpenMenuPath, menuPathRoles } from "../shared/permissions";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const read = (file: string) => readFileSync(path.resolve(__dirname, "..", file), "utf8");
const names = new Map([[7, "Ana Admin"]]);
const noop = () => undefined;
// Termos que o usuário final nunca deve ver.
const TECHNICAL = /PRECONDITION|FEATURE_FLAG|COMMISSION_V2_RELEASED|ENABLED|_KEY|JWT|DATABASE|snapshot|override|payload|mestre|flag\b|undefined|null|\[object/i;

describe("Configurações da empresa: avisos de estado", () => {
  it("desligado (PRECONDITION_FAILED ou status off) e indisponível viram texto claro, sem termo técnico", () => {
    for (const input of [{ errorCode: "PRECONDITION_FAILED" }, { status: "off" }, { status: "unavailable" }, { errorCode: "FORBIDDEN" }, { errorCode: "INTERNAL_SERVER_ERROR" }]) {
      const state = describeBackendState(input);
      expect(state.kind).not.toBe("ok");
      if (state.kind === "ok") continue;
      const out = html(createElement(StateNotice, { state }));
      expect(out).toContain(state.title);
      expect(out).not.toMatch(TECHNICAL);
    }
    expect(describeBackendState({ errorCode: "PRECONDITION_FAILED" })).toMatchObject({ kind: "off", title: "Recurso desligado" });
    expect(describeBackendState({ status: "unavailable" })).toMatchObject({ kind: "unavailable" });
    expect(describeBackendState({ status: "ok" })).toEqual({ kind: "ok" });
  });
});

describe("Configurações da empresa: recursos (as 6 chaves) e itens bloqueados", () => {
  const flags = [
    { key: "RECOVERY_ELIGIBILITY_ENABLED", label: "Elegibilidade de não-comprador para o Recovery (C2/C3)", restartRequired: true, effective: false, override: { enabled: true, createdByUserId: 7, createdAt: new Date("2026-10-21T15:00:00Z") }, pendingRestart: true },
    { key: "COMMISSION_ROLE_MAP_ENABLED", label: "Mapa de papéis da comissão V2 configurável", restartRequired: false, effective: true, override: null, pendingRestart: false },
  ];
  const render = (extra: Partial<Parameters<typeof FlagsPanel>[0]> = {}) => html(createElement(FlagsPanel, { flags, pending: false, onToggle: noop, historyOf: () => undefined, onOpenHistory: noop, openKey: null, unavailable: false, ...extra }));

  it("mostra 'aguardando reinício' e se muda na hora ou só depois de reiniciar", () => {
    const out = render();
    expect(out).toContain("aguardando o reinício do sistema");
    expect(out).toContain("só muda depois de reiniciar o sistema");
    expect(out).toContain("muda na hora");
    expect(out).not.toMatch(/RECOVERY_ELIGIBILITY_ENABLED|COMMISSION_ROLE_MAP_ENABLED/); // nome técnico não aparece
  });
  it("COMMISSION_V2_RELEASED e itens de segurança aparecem só como bloqueados, sem botão e sem valor", () => {
    const out = html(createElement(BlockedItems));
    for (const item of BLOCKED_ITEMS) expect(out).toContain(item.label.replace(/&/g, "&amp;"));
    expect(out).toContain("Bloqueado");
    expect(out).not.toContain("<button");
    expect(out).not.toMatch(/COMMISSION_V2_RELEASED|CSRF|JWT|secret|senha:/i);
    expect(BLOCKED_ITEMS.some(item => /V2/.test(item.label))).toBe(true);
  });
  it("o painel não oferece botão para nenhum item bloqueado e histórico mostra quem e quando", () => {
    const out = render({ openKey: "RECOVERY_ELIGIBILITY_ENABLED", historyOf: () => flagHistory([{ id: 1, enabled: true, createdByUserId: 7, createdAt: new Date("2026-10-21T15:00:00Z") }, { id: 2, enabled: false, createdByUserId: 99, createdAt: new Date("2026-10-20T12:00:00Z") }], names) });
    expect(out).toContain("Ana Admin");
    expect(out).toContain("ligou");
    expect(out).toContain("Usuário nº 99");
    expect(out).toContain("desligou");
    expect((out.match(/<button/g) ?? []).length).toBe(flags.length * 2); // ligar/desligar + histórico por recurso; nada para os bloqueados
  });
  it("sem conseguir conferir as mudanças salvas, desabilita os botões e avisa", () => {
    const out = render({ unavailable: true });
    expect(out).toContain("Não foi possível conferir");
    expect(out).toContain("disabled");
  });
});

describe("Configurações da empresa: indicadores, papéis da comissão e permissões", () => {
  it("indicadores: nome em português, versão e histórico legível", () => {
    const items = [{ code: "utilization", version: 2, label: "Aproveitamento oficial", description: "d", active: true, isDefault: false }, { code: "efficiency", version: 0, label: "Eficiência", description: "", active: false, isDefault: true }];
    const out = html(createElement(IndicatorsPanel, { items, pending: false, onSave: noop, onOpenHistory: noop, openKey: "utilization", historyOf: () => indicatorHistory([{ id: 1, version: 2, label: "Aproveitamento oficial", active: true, createdByUserId: 7, createdAt: new Date("2026-10-21T15:00:00Z") }], names) }));
    expect(out).toContain("Versão 2");
    expect(out).toContain("Texto padrão");
    expect(out).toContain("Oculto");
    expect(out).toContain("Ana Admin");
    expect(out).not.toMatch(TECHNICAL);
  });
  it("papéis da comissão: três partes, nomes simples, aviso de 'só contratos novos' e alerta com destino repetido", () => {
    const base = { version: 1, isDefault: false, ruleRoles: ["captador", "consultor", "fechador"], storedRoles: ["promoter", "liner", "closer"], pending: false, onSave: noop };
    const ok = html(createElement(RoleMapPanel, { ...base, roleMap: { captador: "promoter", consultor: "liner", fechador: "closer" }, history: roleMapHistory([{ id: 1, version: 1, roleMap: JSON.stringify({ captador: "liner", consultor: "promoter", fechador: "closer" }), createdByUserId: 7, createdAt: new Date("2026-10-21T15:00:00Z") }], names) }));
    expect(ok).toContain("só para contratos novos");
    expect(ok).toContain("travada até o aceite da sala");
    expect(ok).toContain("Captador como Consultor (liner)");
    expect(ok).not.toContain('role="alert"');
    expect(ok).not.toMatch(TECHNICAL);
    const dup = html(createElement(RoleMapPanel, { ...base, roleMap: { captador: "liner", consultor: "liner", fechador: "closer" }, history: [] }));
    expect(dup).toContain('role="alert"');
    expect(dup).toContain("disabled");
  });
  it("permissões: administração sempre marcada e travada; só as ações editáveis; ações sensíveis explicadas como fixas", () => {
    const items = [{ key: "export.pii", defaultRoles: ["admin", "finance"], roles: ["admin", "seller"], overridden: true }, { key: "commission.view", defaultRoles: ["admin", "seller", "finance"], roles: ["admin", "seller", "finance"], overridden: false }];
    const out = html(createElement(PermissionsPanel, { items, roles: ["admin", "seller", "finance", "service"], pending: false, onSave: noop, onOpenHistory: noop, openKey: "export.pii", historyOf: () => permissionHistory([{ id: 1, roles: JSON.stringify(["admin", "seller"]), createdByUserId: 7, createdAt: new Date("2026-10-21T15:00:00Z") }], names) }));
    expect(out).toContain("Exportar fichas com CPF");
    expect(out).toContain("Alterado");
    expect(out).toContain("Padrão");
    expect(out).toContain("(sempre)");
    expect(out).toMatch(/disabled=""[^>]*checked|checked=""[^>]*disabled/); // caixa da administração
    expect(out).toContain("validar venda");
    expect(out).toContain("passou a valer para: Administração, Vendas");
    expect(out).not.toMatch(TECHNICAL);
    expect(html(createElement(HistoryList, { entries: [] }))).toContain("Ainda não houve mudança");
  });
});

describe("Configurações da empresa: rota e menu só do admin, sem segredo na página", () => {
  it("a entrada é só do admin no menu e na rota", () => {
    expect(menuPathRoles["/configuracoes-empresa"]).toEqual(["admin"]);
    for (const role of ["seller", "finance", "service", "user", null, undefined] as const) expect(canOpenMenuPath(role as never, "/configuracoes-empresa")).toBe(false);
    expect(canOpenMenuPath("admin", "/configuracoes-empresa")).toBe(true);
    expect(read("client/src/components/DashboardLayout.tsx")).toContain('path: "/configuracoes-empresa"');
    expect(read("client/src/App.tsx")).toMatch(/path="\/configuracoes-empresa" component=\{CompanySettings\}/);
  });
  it("a página só chama rotas já existentes e não toca segredo nem COMMISSION_V2_RELEASED", () => {
    const page = read("client/src/pages/CompanySettings.tsx") + read("client/src/components/crm/companySettings/panels.tsx");
    expect(page).not.toMatch(/COMMISSION_V2_RELEASED|process\.env|ENV\.|SECRET|INTEGRATION_KEY|JWT/);
    for (const route of ["featureFlags.list", "featureFlags.set", "permissionOverrides.set", "commissionRoleMap.save", "officialIndicators.saveCatalogEntry"]) expect(page).toContain(route);
  });
});
