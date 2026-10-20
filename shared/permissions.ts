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
} as const satisfies Record<string, readonly InternalPermissionRole[]>;

export type Capability = keyof typeof capabilityMatrix;

export function canAccess(role: InternalPermissionRole, area: PermissionArea) {
  return (permissionMatrix[area] as readonly InternalPermissionRole[]).includes(role);
}

export function canCapability(role: InternalPermissionRole | "user", capability: Capability) {
  if (role === "user") return false;
  return (capabilityMatrix[capability] as readonly InternalPermissionRole[]).includes(role);
}

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
