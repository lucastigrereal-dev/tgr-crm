// Fonte única de RBAC (ADR-002): o servidor aplica e a tela só esconde o que o servidor recusaria.
export const permissionMatrix = {
  customers: ["admin", "seller", "finance", "service"],
  contracts: ["admin", "seller", "finance", "service"],
  reservations: ["admin", "service"],
  finance: ["admin", "finance"],
  commissions: ["admin", "seller", "finance"],
  imports: ["admin"],
  reports: ["admin", "seller", "finance", "service"],
  governance: ["admin"],
} as const;

export type InternalPermissionRole = "admin" | "seller" | "finance" | "service";
export type PermissionArea = keyof typeof permissionMatrix;

export const capabilityMatrix = {
  "sales.proposal.create": ["admin", "seller"],
  "sales.discount.request": ["admin", "seller"],
  "sales.discount.approve": ["admin"],
  "finance.entry.create": ["admin", "finance"],
  "finance.payment.reconcile": ["admin", "finance"],
  "finance.installment.settle": ["admin", "finance"],
  "finance.transfer.create": ["admin", "finance"],
  "finance.transfer.pay": ["admin", "finance"],
  "commission.view": ["admin", "seller", "finance"],
  "commission.pay": ["admin", "finance"],
  "contract.cancel.request": ["admin", "seller", "finance", "service"],
  // ADR-002 (2026-10-04): pedir distrato é amplo; decidir/executar é só de papel superior (não há "manager" no CRM).
  "contract.cancel.decide": ["admin"],
  "contract.cancel.execute": ["admin"],
  // PRD Apêndice B #11: ativar contrato (papel assinado e anexado) é registro da administração; o CRM não tem "manager".
  "contract.activate": ["admin"],
  // ADR-007 (V6): o papel "gerente" do CRM é MAPEADO para `admin` (o CRM não tem papel manager; seller = closer não tem).
  // POLICY_PENDING CRM_MANAGER_ROLE: se o CRM ganhar papel "gerente" próprio, só esta matriz muda.
  // CRM-C1 (decisão do titular, 20/10): a validação oficial é do ADMINISTRATIVO autorizado, sem gate final de gerente. Papel admin sempre; papel finance
  // só com concessão vigente (sale_validator_grants, dada pelo admin; conferido no servidor). A matriz acima é só o teto por papel.
  "sale.payment.confirm": ["admin", "finance"],
  "sale.documents.confer": ["admin", "finance"],
  "sale.receipt.confer": ["admin", "finance"],
  "sale.validate": ["admin", "finance"],
  // Leitura dos portões da venda (inclui nota de conferência do pagamento e referência de documento): só gerência e financeiro.
  "sale.validation.view": ["admin", "finance"],
  "document.read": ["admin", "seller", "finance", "service"],
  "document.sign": ["admin"],
  "export.pii": ["admin", "finance"],
  // Ficha arquivada (casal que não comprou saiu da vista da sala): quem ainda abre. Era ARCHIVED_SHEET_ROLES fixo; agora capacidade editável (item 4).
  "sheet.archived.open": ["admin", "finance"],
} as const satisfies Record<string, readonly InternalPermissionRole[]>;

export type Capability = keyof typeof capabilityMatrix;

export function canAccess(role: InternalPermissionRole, area: PermissionArea) {
  return (permissionMatrix[area] as readonly InternalPermissionRole[]).includes(role);
}

export function canCapability(role: InternalPermissionRole | "user", capability: Capability) {
  if (role === "user") return false;
  const overridden = overrides.capabilities[capability];
  return ((overridden ?? capabilityMatrix[capability]) as readonly InternalPermissionRole[]).includes(role);
}

// ---------------------------------------------------------------------------------------------------------------------
// Item 4 (admin): permissão por papel EDITÁVEL por AÇÃO (capacidade), sobre estes padrões (fallback = os valores acima, sempre). Atrás de PERMISSION_OVERRIDES_ENABLED (desligada: nada é
// carregado e tudo vale como antes). Regras fixas (piso), aplicadas por `sanitizePermissionOverrides` no servidor E no navegador, nunca confiando no que veio da tela:
//  1. SÓ as capacidades de EDITABLE_CAPABILITIES são editáveis, e cada uma está LIGADA de verdade na autorização do servidor (ver comentário de cada uma). O resto (validar venda,
//     pagar, distrato, financeiro, assinar...) é piso fixo.
//  2. O admin sempre está em toda lista editável (admin nunca se tranca).
//  3. Papel desconhecido é descartado; lista vazia vira apenas ["admin"].
// TELAS (menuPathRoles) ficam FIXAS por enquanto: esconder item do menu não fecha a rota digitada nem a API; fechar rota + procedures por tela é um PR próprio.
// ---------------------------------------------------------------------------------------------------------------------
export const INTERNAL_ROLES = ["admin", "seller", "finance", "service"] as const satisfies readonly InternalPermissionRole[];
/**
 * Ligadas ao servidor: `export.pii` (captureSheet.export, assertCapability), `sheet.archived.open` (canOpenArchivedSheet), `document.read` (storageAccess.authorizeStorageRead:
 * leitura de documento de cliente/contrato) e `commission.view` (commissionsProcedure: scorecards e overview; conceder a um papel sem escopo próprio mostra TODAS, como o finance).
 */
export const EDITABLE_CAPABILITIES = ["export.pii", "sheet.archived.open", "document.read", "commission.view"] as const satisfies readonly Capability[];

export type PermissionOverrides = { capabilities: Partial<Record<Capability, readonly InternalPermissionRole[]>> };
let overrides: PermissionOverrides = { capabilities: {} };

const cleanRoles = (value: unknown): InternalPermissionRole[] => {
  const given = Array.isArray(value) ? value.filter((role): role is InternalPermissionRole => typeof role === "string" && (INTERNAL_ROLES as readonly string[]).includes(role)) : [];
  return INTERNAL_ROLES.filter(role => role === "admin" || given.includes(role));
};

export function sanitizePermissionOverrides(raw: unknown): PermissionOverrides {
  const out: PermissionOverrides = { capabilities: {} };
  const input = (raw && typeof raw === "object" ? raw : {}) as { capabilities?: Record<string, unknown> };
  for (const capability of EDITABLE_CAPABILITIES) {
    if (input.capabilities && Object.prototype.hasOwnProperty.call(input.capabilities, capability)) out.capabilities[capability] = cleanRoles(input.capabilities[capability]);
  }
  return out;
}

export function setPermissionOverrides(raw: unknown) { overrides = sanitizePermissionOverrides(raw); }
export function getPermissionOverrides(): PermissionOverrides { return overrides; }

// KAN-31 (teste de navegador): telas do menu seguem o RBAC do procedure principal de cada rota (server/routers/access.ts).
// Rota ausente aqui = qualquer papel interno. A tela nunca mostra o que o servidor recusaria (403 virava R$ 0,00 na UI).
export const menuPathRoles: Record<string, readonly InternalPermissionRole[]> = {
  "/sala-de-vendas": ["admin", "seller", "service"],
  "/vouchers": ["admin", "seller", "service"],
  // LGPD (17/10): o financeiro é "administrativo" e abre a ficha arquivada; captureSheet.byCode = internalProcedure + regra de vista.
  "/ficha": ["admin", "seller", "finance", "service"],
  "/captacao": ["admin", "seller"],
  "/vendas": ["admin", "seller"],
  "/campanhas": ["admin", "seller"],
  "/comissoes": ["admin", "seller", "finance"],
  "/financeiro": ["admin", "finance"],
  "/reajustes": ["admin", "finance"],
  "/politicas": ["admin", "finance"],
  "/reservas": ["admin", "service"],
  "/equipe": ["admin"],
  "/importar": ["admin"],
  "/configuracoes-projeto": ["admin"],
  "/dicionarios": ["admin"],
  "/integracoes": ["admin"],
  "/auditoria": ["admin"],
};

export function canOpenMenuPath(role: InternalPermissionRole | "user" | null | undefined, path: string) {
  if (!role || role === "user") return false;
  const base = Object.keys(menuPathRoles).find(prefix => path === prefix || path.startsWith(prefix + "/"));
  return base ? menuPathRoles[base].includes(role) : true;
}
