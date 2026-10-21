import type { CommissionRoleV2Mapped } from "./commissionAutomation";

/**
 * Item 5 (admin): mapa de papéis da comissão V2 (papel da regra -> papel gravado/quem recebe) como configuração VERSIONADA. O padrão é a constante abaixo
 * (captador=promoter, consultor=liner, fechador=closer). Só vale com COMMISSION_ROLE_MAP_ENABLED e, mesmo assim, só quando o motor V2 está LIBERADO
 * (com o V2 travado esta configuração nunca é lida). Cada contrato fixa o mapa vigente no PRIMEIRO lançamento V2 (snapshot), como a versão da regra.
 */
export const COMMISSION_V2_RULE_ROLES = ["captador", "consultor", "fechador"] as const;
export type CommissionV2RuleRole = (typeof COMMISSION_V2_RULE_ROLES)[number];
export const COMMISSION_STORED_ROLES = ["promoter", "liner", "closer"] as const;

export type CommissionRoleMap = Record<CommissionV2RuleRole, CommissionRoleV2Mapped>;
export const DEFAULT_COMMISSION_V2_ROLE_MAP: CommissionRoleMap = { captador: "promoter", consultor: "liner", fechador: "closer" };

/** Mapa válido = os 3 papéis da regra, cada um para um papel gravado conhecido, sem repetir destino (repetir pagaria a mesma pessoa duas vezes). */
export function parseCommissionRoleMap(value: unknown): CommissionRoleMap | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== COMMISSION_V2_RULE_ROLES.length) return null;
  const out = {} as CommissionRoleMap;
  for (const role of COMMISSION_V2_RULE_ROLES) {
    const target = raw[role];
    if (typeof target !== "string" || !(COMMISSION_STORED_ROLES as readonly string[]).includes(target)) return null;
    out[role] = target as CommissionRoleV2Mapped;
  }
  return new Set(Object.values(out)).size === COMMISSION_V2_RULE_ROLES.length ? out : null;
}
