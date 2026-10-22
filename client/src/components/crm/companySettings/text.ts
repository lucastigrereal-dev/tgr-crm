// Textos e regras puras da tela "Configurações da empresa" (português simples; nada de nome técnico de variável, valor de segredo ou termo de programador).

export type BackendState = { kind: "ok" } | { kind: "off" | "unavailable" | "forbidden" | "error"; title: string; text: string };

/** Traduz a resposta do servidor (código do erro ou situação da lista) em um aviso claro para o usuário. */
export function describeBackendState(input: { errorCode?: string | null; status?: string | null }): BackendState {
  if (input.errorCode === "PRECONDITION_FAILED" || input.status === "off") {
    return { kind: "off", title: "Recurso desligado", text: "Este recurso está desligado pela equipe técnica. Nada aqui muda o funcionamento do sistema enquanto ele estiver desligado. Peça para a equipe técnica ligar quando for a hora." };
  }
  if (input.status === "unavailable") {
    return { kind: "unavailable", title: "Não foi possível ler as configurações", text: "O sistema não conseguiu consultar os dados desta tela agora. Os valores de hoje continuam valendo. Tente de novo em alguns minutos; se continuar, avise a equipe técnica." };
  }
  if (input.errorCode === "FORBIDDEN" || input.errorCode === "UNAUTHORIZED") {
    return { kind: "forbidden", title: "Sem permissão", text: "Só a administração pode ver e alterar estas configurações." };
  }
  if (input.errorCode) return { kind: "error", title: "Algo deu errado", text: "Não foi possível carregar esta parte agora. Tente de novo; se continuar, avise a equipe técnica." };
  return { kind: "ok" };
}

export const ROLE_LABELS: Record<string, string> = { admin: "Administração", seller: "Vendas", finance: "Financeiro", service: "Atendimento" };
export const roleLabel = (role: string) => ROLE_LABELS[role] ?? "Perfil desconhecido";

export const CAPABILITY_LABELS: Record<string, { label: string; help: string }> = {
  "export.pii": { label: "Exportar fichas com CPF", help: "Quem pode baixar a planilha das fichas com o CPF dos casais." },
  "sheet.archived.open": { label: "Abrir ficha arquivada", help: "Quem ainda abre a ficha de um casal que não comprou, depois que ela sai da vista da sala." },
  "document.read": { label: "Ler documentos de clientes e contratos", help: "Quem pode abrir os arquivos anexados (documentos e contratos)." },
  "commission.view": { label: "Ver comissões", help: "Quem consulta os painéis de comissão. Quem recebe este acesso e não é do time de vendas vê todas as comissões, como o financeiro." },
};
export const capabilityLabel = (key: string) => CAPABILITY_LABELS[key]?.label ?? "Permissão";

export const INDICATOR_LABELS: Record<string, string> = { utilization: "Aproveitamento", efficiency: "Eficiência" };

// Papel da regra de comissão -> como aparece para o usuário; e papel gravado -> como aparece.
export const RULE_ROLE_LABELS: Record<string, string> = { captador: "Captador", consultor: "Consultor", fechador: "Fechador" };
export const STORED_ROLE_LABELS: Record<string, string> = { promoter: "Promotor (quem captou)", liner: "Consultor (liner)", closer: "Fechador (closer)" };

/** O que a tela mostra só para leitura: nunca ligável aqui e sem nenhum valor. */
export const BLOCKED_ITEMS: Array<{ label: string; reason: string }> = [
  { label: "Liberação das comissões da nova regra (V2)", reason: "Travada até o aceite da sala. Só o Lucas libera, fora desta tela." },
  { label: "Proteção contra pedidos vindos de outros sites", reason: "Item de segurança: fica com a equipe técnica." },
  { label: "Chaves de integração e senhas do sistema", reason: "Segredos nunca aparecem nem são alterados aqui." },
  { label: "Acesso, login e endereços de rede", reason: "Item de segurança: fica com a equipe técnica." },
  { label: "O interruptor desta própria tela de recursos", reason: "Só a equipe técnica liga, para ninguém se trancar fora." },
  { label: "O interruptor das permissões editáveis", reason: "Só a equipe técnica liga: é uma regra de segurança." },
];

export function formatWhen(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "data desconhecida" : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Recife" });
}

export type HistoryEntry = { key: string; who: string; when: string; what: string };
/** Nome de quem mudou: pelo cadastro da equipe; sem cadastro, "usuário nº N" (nunca e-mail). */
export function whoName(userId: number, names: Map<number, string>): string { return names.get(userId) ?? `Usuário nº ${userId}`; }

// ---- Histórico: linhas do servidor -> frases simples
type Who = { createdByUserId: number; createdAt: unknown };
const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };

export function flagHistory(rows: Array<Who & { id: number; enabled: boolean }>, names: Map<number, string>): HistoryEntry[] {
  return rows.map(r => ({ key: String(r.id), who: whoName(r.createdByUserId, names), when: formatWhen(r.createdAt), what: r.enabled ? "ligou" : "desligou" }));
}
export function indicatorHistory(rows: Array<Who & { id: number; version: number; label: string; active: boolean }>, names: Map<number, string>): HistoryEntry[] {
  return rows.map(r => ({ key: String(r.id), who: whoName(r.createdByUserId, names), when: formatWhen(r.createdAt), what: `versão ${r.version}, nome "${r.label}"${r.active ? "" : ", indicador oculto"}` }));
}
export function roleMapHistory(rows: Array<Who & { id: number; version: number; roleMap: string }>, names: Map<number, string>): HistoryEntry[] {
  return rows.map(r => {
    const map = parseJson(r.roleMap) as Record<string, string> | null;
    const text = map ? Object.entries(map).map(([rule, stored]) => `${RULE_ROLE_LABELS[rule] ?? "parte"} como ${STORED_ROLE_LABELS[stored] ?? "papel"}`).join("; ") : "mapa ilegível";
    return { key: String(r.id), who: whoName(r.createdByUserId, names), when: formatWhen(r.createdAt), what: `versão ${r.version}: ${text}` };
  });
}
export function permissionHistory(rows: Array<Who & { id: number; roles: string }>, names: Map<number, string>): HistoryEntry[] {
  return rows.map(r => {
    const roles = parseJson(r.roles);
    return { key: String(r.id), who: whoName(r.createdByUserId, names), when: formatWhen(r.createdAt), what: Array.isArray(roles) ? `passou a valer para: ${roles.map(role => roleLabel(String(role))).join(", ")}` : "valor ilegível" };
  });
}

/** Mensagem de erro de SALVAR para o toast: nunca o texto cru do servidor (pode trazer nome de variável, papel ou chave). Códigos conhecidos têm texto próprio; o resto é genérico. */
export function describeMutationError(error: unknown): string {
  const code = error && typeof error === "object" && "data" in error ? (error as { data?: { code?: string } }).data?.code ?? null : null;
  if (code === "BAD_REQUEST") return "Os dados informados não são válidos. Confira e tente de novo.";
  if (code === "FORBIDDEN" && error && typeof error === "object" && "message" in error && /piso fixo|fora da allow-list|n[aã]o pode ser alterad/i.test(String((error as { message?: unknown }).message))) return "Este item é fixo e não pode ser alterado por aqui.";
  if (code === "CONFLICT") return "Este usuário já tem uma autorização ativa. Atualize a lista; para trocar a validade, revogue antes.";
  if (code === "NOT_FOUND") return "O registro não foi encontrado ou já foi revogado. Atualize a lista.";
  if (code === "FORBIDDEN" || code === "PRECONDITION_FAILED" || code === "UNAUTHORIZED") {
    const state = describeBackendState({ errorCode: code });
    return state.kind === "ok" ? "Não foi possível salvar agora. Tente de novo." : state.text;
  }
  return "Não foi possível salvar agora. Tente de novo; se continuar, avise a equipe técnica.";
}
