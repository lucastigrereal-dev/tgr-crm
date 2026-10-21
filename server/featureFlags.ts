import { inArray, max } from "drizzle-orm";
import { featureFlagOverrides } from "../drizzle/schema";
import { ENV } from "./_core/env";
import type { getDb } from "./db";
import { logger } from "./logger";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Item 6 (admin): a tela só mexe nas flags desta ALLOW-LIST (nome da variável -> propriedade de ENV). `restartRequired`: a flag é lida no BOOT (rotas e jobs registrados em
 * `_core/index.ts`); a sobrescrita vale no próximo início. As demais são lidas a cada chamada e valem na hora. O interruptor mestre (FEATURE_FLAG_OVERRIDES_ENABLED) liga a
 * tela e a aplicação das sobrescritas; ele mesmo NÃO está na lista.
 */
export const FLAG_ALLOWLIST = {
  RECOVERY_ELIGIBILITY_ENABLED: { prop: "recoveryEligibilityEnabled", label: "Elegibilidade de não-comprador para o Recovery (C2/C3)", restartRequired: true },
  ATTENDANCE_RECEIVER_ENABLED: { prop: "attendanceReceiverEnabled", label: "Receptor do registro de atendimento (C1)", restartRequired: true },
  ENCOUNTER_TIMES_RECEIVER_ENABLED: { prop: "encounterTimesReceiverEnabled", label: "Receptor dos tempos do encontro", restartRequired: true },
  NQ_READ_ENDPOINT_ENABLED: { prop: "nqReadEndpointEnabled", label: "Endpoint de leitura do NQ para o Sales Command", restartRequired: true },
  OFFICIAL_INDICATOR_CATALOG_ENABLED: { prop: "officialIndicatorCatalogEnabled", label: "Catálogo editável de indicadores oficiais", restartRequired: false },
  COMMISSION_ROLE_MAP_ENABLED: { prop: "commissionRoleMapEnabled", label: "Mapa de papéis da comissão V2 configurável", restartRequired: false },
} as const satisfies Record<string, { prop: keyof typeof ENV; label: string; restartRequired: boolean }>;
export type FlagKey = keyof typeof FLAG_ALLOWLIST;
export const FLAG_KEYS = Object.keys(FLAG_ALLOWLIST) as [FlagKey, ...FlagKey[]];

/**
 * Deny-list EXPLÍCITA (documentação executável + teste): nunca passam pela tela, mesmo que alguém as coloque na allow-list por engano (o teste falha). COMMISSION_V2_RELEASED é
 * decisão do Lucas depois do aceite da sala; o resto é segurança/auth/chave.
 */
export const FLAG_DENYLIST = ["COMMISSION_V2_RELEASED", "FEATURE_FLAG_OVERRIDES_ENABLED", "CSRF_ORIGIN_CHECK_ENABLED", "CSRF_ALLOWED_ORIGINS", "JWT_SECRET", "DATABASE_URL", "OWNER_OPEN_ID", "OAUTH_SERVER_URL", "TRUST_PROXY_HOPS", "SALES_COMMAND_INTEGRATION_KEY", "RECOVERY_INTEGRATION_KEY", "RELATIONSHIP_CRM_INTEGRATION_KEY", "FINANCIAL_CRM_INTEGRATION_KEY", "SALES_COMMAND_CANCELLATION_KEY", "BUILT_IN_FORGE_API_KEY"] as const;

export const isAllowedFlag = (key: string): key is FlagKey => Object.prototype.hasOwnProperty.call(FLAG_ALLOWLIST, key) && !(FLAG_DENYLIST as readonly string[]).includes(key);

/** Valor das flags no início do processo (antes de qualquer sobrescrita): base para dizer se falta reiniciar. */
const bootValues: Record<string, boolean> = Object.fromEntries(FLAG_KEYS.map(key => [key, Boolean(ENV[FLAG_ALLOWLIST[key].prop])]));
export const bootValueOf = (key: FlagKey) => bootValues[key]!;
export const effectiveValueOf = (key: FlagKey) => Boolean(ENV[FLAG_ALLOWLIST[key].prop]);
function setEffective(key: FlagKey, enabled: boolean) { (ENV as Record<string, unknown>)[FLAG_ALLOWLIST[key].prop] = enabled; }

/** Sobrescrita vigente por flag = a linha de MAIOR id (MAX por flag: um flag com muito histórico não esconde os outros; nada é truncado). */
export async function latestOverrides(db: Db): Promise<Map<FlagKey, { enabled: boolean; createdByUserId: number; createdAt: Date }>> {
  const latest = await db.select({ flagKey: featureFlagOverrides.flagKey, id: max(featureFlagOverrides.id) }).from(featureFlagOverrides).groupBy(featureFlagOverrides.flagKey);
  const ids = latest.map(row => row.id).filter((id): id is number => id !== null);
  const out = new Map<FlagKey, { enabled: boolean; createdByUserId: number; createdAt: Date }>();
  if (!ids.length) return out;
  const rows = await db.select().from(featureFlagOverrides).where(inArray(featureFlagOverrides.id, ids));
  for (const row of rows) if (isAllowedFlag(row.flagKey)) out.set(row.flagKey, { enabled: row.enabled, createdByUserId: row.createdByUserId, createdAt: row.createdAt });
  return out;
}

/** BOOT: aplica as sobrescritas à ENV antes de registrar rotas/jobs. Mestre desligado = não faz nada. Falha (tabela ausente) mantém a ENV e só registra. */
export async function applyPersistedFlagOverrides(db: Db | null | undefined): Promise<number> {
  if (!ENV.featureFlagOverridesEnabled || !db) return 0;
  try {
    const overrides = await latestOverrides(db);
    overrides.forEach((value, key) => setEffective(key, value.enabled));
    return overrides.size;
  } catch (error) {
    logger.warn("Feature flag overrides not applied; environment values kept", { errorName: error instanceof Error ? error.name : "non-Error" });
    return 0;
  }
}

/**
 * Depois do COMMIT: relê a sobrescrita mais recente DESTA flag (a que o `list` mostra) e só então aplica à ENV, serializado por flag neste processo. Assim dois `set`
 * concorrentes (ids auto-increment podem comitar fora de ordem) terminam com valor efetivo = valor persistido mais recente. Só as flags lidas a cada chamada; as de boot esperam o reinício.
 */
const applyQueues = new Map<FlagKey, Promise<unknown>>();
export function applyLatestOverrideLive(db: Db, key: FlagKey): Promise<void> {
  if (FLAG_ALLOWLIST[key].restartRequired) return Promise.resolve();
  const run = async () => {
    const latest = (await latestOverrides(db)).get(key);
    if (latest) setEffective(key, latest.enabled);
  };
  const next = (applyQueues.get(key) ?? Promise.resolve()).then(run, run);
  applyQueues.set(key, next.catch(() => undefined));
  return next;
}
