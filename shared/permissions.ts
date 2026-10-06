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
  "sale.payment.confirm": ["admin"],
  "sale.validate": ["admin"],
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
