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

export function canAccess(role: InternalPermissionRole, area: PermissionArea) {
  return (permissionMatrix[area] as readonly InternalPermissionRole[]).includes(role);
}
