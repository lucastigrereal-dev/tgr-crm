import { setPermissionOverrides } from "@shared/permissions";

/**
 * Item 4: aplica no navegador as sobrescritas de permissão que o servidor devolveu (`permissionOverrides.effective`). A MESMA sanitização do servidor roda aqui
 * (admin sempre presente, só capacidades/telas editáveis, tela só estreita), então nada vindo da rede consegue abrir uma tela que o piso fecha. Sem dados = padrões de hoje.
 */
export function syncPermissionOverrides(data: { enabled: boolean; overrides: unknown } | undefined | null) {
  setPermissionOverrides(data?.enabled ? data.overrides : {});
}
