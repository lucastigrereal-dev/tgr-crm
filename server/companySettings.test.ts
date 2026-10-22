import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlockedItems, FlagsPanel, HistoryList, IndicatorsPanel, PermissionsPanel, RoleMapPanel, SaleValidatorsPanel, StateNotice } from "../client/src/components/crm/companySettings/panels";
import { BLOCKED_ITEMS, describeBackendState, describeMutationError, flagHistory, indicatorHistory, permissionHistory, roleMapHistory } from "../client/src/components/crm/companySettings/text";
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

describe("Configurações da empresa: erros de histórico, acessibilidade e avisos de salvar", () => {
  const flag = { key: "X", label: "Receptor do registro de atendimento (C1)", restartRequired: true, effective: false, override: { enabled: true, createdByUserId: 7, createdAt: new Date("2026-10-21T15:00:00Z") }, pendingRestart: true };
  const base = { pending: false, onToggle: noop, historyOf: () => undefined, onOpenHistory: noop, openKey: null as string | null, unavailable: false };

  it("(P2-1) histórico com erro mostra aviso claro (nunca 'Carregando' eterno) e, com status indisponível, o botão de histórico fica desabilitado", () => {
    const failed = html(createElement(HistoryList, { entries: "error" }));
    expect(failed).toContain("Não foi possível ler o histórico");
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain("Carregando");
    const open = html(createElement(FlagsPanel, { ...base, flags: [flag], openKey: "X", historyOf: () => "error" }));
    expect(open).toContain("Não foi possível ler o histórico");
    expect(open).not.toContain("Carregando");
    const down = html(createElement(FlagsPanel, { ...base, flags: [flag], unavailable: true }));
    expect(down).toContain("Não foi possível ler o histórico");
    const historyButtons = down.match(/<button[^>]*>(Ver|Ocultar) histórico<\/button>/g) ?? [];
    expect(historyButtons).toHaveLength(1);
    expect(historyButtons[0]).toContain("disabled");
    for (const panel of [
      html(createElement(RoleMapPanel, { roleMap: { captador: "promoter", consultor: "liner", fechador: "closer" }, version: 1, isDefault: false, ruleRoles: ["captador", "consultor", "fechador"], storedRoles: ["promoter", "liner", "closer"], pending: false, onSave: noop, history: "error" })),
      html(createElement(PermissionsPanel, { items: [{ key: "export.pii", defaultRoles: ["admin"], roles: ["admin"], overridden: false }], roles: ["admin", "seller"], pending: false, onSave: noop, onOpenHistory: noop, openKey: "export.pii", historyOf: () => "error" })),
      html(createElement(IndicatorsPanel, { items: [{ code: "utilization", version: 1, label: "Aproveitamento", description: "", active: true, isDefault: false }], pending: false, onSave: noop, onOpenHistory: noop, openKey: "utilization", historyOf: () => "error" })),
    ]) expect(panel).toContain("Não foi possível ler o histórico");
  });

  it("(P2-2) o nome acessível do botão sai do MESMO valor do texto visível e do clique (escolha salva ou, sem ela, o valor atual)", () => {
    const labelsOf = (f: typeof flag) => { const out = html(createElement(FlagsPanel, { ...base, flags: [f] })); return { aria: /aria-label="(Ligar|Desligar): /.exec(out)?.[1], visible: />(Ligar|Desligar)<\/button>/.exec(out)?.[1] }; };
    expect(labelsOf(flag)).toEqual({ aria: "Desligar", visible: "Desligar" }); // salvo ligado, efetivo desligado: o texto e o clique já usam o salvo
    expect(labelsOf({ ...flag, override: null })).toEqual({ aria: "Ligar", visible: "Ligar" });
    expect(labelsOf({ ...flag, override: null, effective: true })).toEqual({ aria: "Desligar", visible: "Desligar" });
    expect(labelsOf({ ...flag, override: { ...flag.override!, enabled: false }, effective: true })).toEqual({ aria: "Ligar", visible: "Ligar" });
    const source = read("client/src/components/crm/companySettings/panels.tsx");
    expect(source).toContain("onToggle(flag.key, !configured)");
    expect(source).toContain('aria-label={`${configured ? "Desligar" : "Ligar"}: ${flag.label}`}');
  });

  it("(P2-3) o aviso de salvar nunca mostra o texto cru do servidor: códigos conhecidos têm texto próprio e o resto é genérico, sem nome de recurso, variável ou papel", () => {
    const raw = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });
    const cases = [
      raw("FORBIDDEN", "Esta flag não pode ser alterada pela tela (fora da allow-list). RECOVERY_ELIGIBILITY_ENABLED"),
      raw("FORBIDDEN", "Apenas a administração pode executar esta ação."),
      raw("PRECONDITION_FAILED", "Tela de flags desligada (FEATURE_FLAG_OVERRIDES_ENABLED)."),
      raw("BAD_REQUEST", "Mapa inválido: informe captador, consultor e fechador (promoter, liner ou closer)."),
      raw("UNAUTHORIZED", "Please login (10001)"),
      raw("INTERNAL_SERVER_ERROR", "Failed query: insert into feature_flag_overrides ... COMMISSION_V2_RELEASED"),
      new Error("Failed to fetch"),
      "texto solto",
      null,
    ];
    for (const error of cases) {
      const text = describeMutationError(error);
      expect(text).not.toMatch(TECHNICAL);
      expect(text).not.toMatch(/promoter|liner|closer|allow-list|insert|query|10001|ELIGIBILITY|feature_flag/i);
      expect(text.length).toBeGreaterThan(20);
    }
    expect(describeMutationError(raw("BAD_REQUEST", "x"))).toContain("não são válidos");
    expect(describeMutationError(raw("FORBIDDEN", "Esta permissão faz parte do piso fixo e não pode ser alterada pela tela."))).toContain("fixo");
    expect(describeMutationError(raw("PRECONDITION_FAILED", "x"))).toContain("desligado");
    const page = read("client/src/pages/CompanySettings.tsx");
    expect(page).not.toMatch(/toast\.error\((?!describeMutationError)/);
    expect(page).not.toContain("error.message");
  });
});

describe("Configurações da empresa: administrativo autorizado", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const grants = [
    { id: 1, userId: 5, userName: "Bia Financeiro", note: "cobertura de férias", validUntil: new Date("2026-12-01T00:00:00Z"), createdAt: new Date("2026-10-20T10:00:00Z"), revokedAt: null },
    { id: 2, userId: 6, userName: "Caio Financeiro", note: null, validUntil: new Date("2026-10-01T00:00:00Z"), createdAt: new Date("2026-09-20T10:00:00Z"), revokedAt: null },
    { id: 3, userId: 8, userName: "Duda Financeiro", note: null, validUntil: null, createdAt: new Date("2026-09-01T10:00:00Z"), revokedAt: new Date("2026-09-10T10:00:00Z") },
  ];
  const render = (extra: Partial<Parameters<typeof SaleValidatorsPanel>[0]> = {}) => html(createElement(SaleValidatorsPanel, { grants, candidates: [{ id: 9, name: "Eva Financeiro" }], segregationEnabled: false, pending: false, now, onGrant: noop, onRevoke: noop, onSetSegregation: noop, ...extra }));

  it("lista ativa, vencida e revogada; só a não revogada tem botão de revogar", () => {
    const out = render();
    expect(out).toContain("Bia Financeiro"); expect(out).toContain("Ativa"); expect(out).toContain("Vencida"); expect(out).toContain("Revogada");
    expect(out).toContain("Revogar a autorização de Bia Financeiro"); expect(out).toContain("Revogar a autorização de Caio Financeiro");
    expect(out).not.toContain("Revogar a autorização de Duda Financeiro");
    expect(out).toContain("Sem prazo"); expect(out).toContain("cobertura de férias");
  });
  it("tem o formulário (pessoa, validade, observação) e o interruptor de segregação com o estado atual", () => {
    const out = render();
    expect(out).toContain("Eva Financeiro"); expect(out).toContain('aria-label="Válida até"'); expect(out).toContain('aria-label="Observação"');
    expect(out).toContain("Ligar: separar quem confere de quem valida");
    expect(render({ segregationEnabled: true })).toContain("Desligar: separar quem confere de quem valida");
  });
  it("sem candidatos e sem autorizações mostra avisos claros; tudo desabilita enquanto salva", () => {
    const out = render({ grants: [], candidates: [] });
    expect(out).toContain("Nenhuma autorização registrada"); expect(out).toContain("Não há ninguém do financeiro");
    expect(render({ pending: true })).toMatch(/disabled=""[^>]*aria-label="Revogar/);
  });
  it("sem termo técnico na tela; a aba existe só na tela do admin e usa as rotas de admin existentes", () => {
    expect(render()).not.toMatch(TECHNICAL);
    const page = read("client/src/pages/CompanySettings.tsx");
    expect(page).toContain('value="administrativo">Administrativo autorizado');
    for (const route of ["saleValidation.grants.list", "saleValidation.grants.grant", "saleValidation.grants.revoke", "saleValidation.segregation.get", "saleValidation.segregation.set"]) expect(page).toContain(`trpc.${route}`);
    const router = read("server/routers/saleValidation.ts");
    expect(router.match(/(?:list|grant|revoke|get|set): adminProcedure/g)?.length).toBe(5);
    expect(canOpenMenuPath("admin", "/configuracoes-empresa")).toBe(true);
    expect(canOpenMenuPath("finance", "/configuracoes-empresa")).toBe(false);
  });
  it("erros de concessão têm texto próprio, sem texto cru do servidor", () => {
    const raw = (code: string) => Object.assign(new Error("Failed query insert sale_validator_grants"), { data: { code } });
    expect(describeMutationError(raw("CONFLICT"))).toContain("já tem uma autorização ativa");
    expect(describeMutationError(raw("NOT_FOUND"))).toContain("revogado");
    for (const code of ["CONFLICT", "NOT_FOUND"]) expect(describeMutationError(raw(code))).not.toMatch(/insert|query|sale_validator/i);
  });
});
