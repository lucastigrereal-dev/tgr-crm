import { inArray, max } from "drizzle-orm";
import { rolePermissionOverrides } from "../drizzle/schema";
import { ENV } from "./_core/env";
import type { getDb } from "./db";
import { logger } from "./logger";
import { setPermissionOverrides } from "../shared/permissions";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type PermissionOverrideRow = { permKey: string; roles: string[]; createdByUserId: number; createdAt: Date };

/** Sobrescrita vigente por chave = a de MAIOR id (MAX por chave: nada é truncado). */
export async function latestPermissionOverrides(db: Db): Promise<PermissionOverrideRow[]> {
  const latest = await db.select({ id: max(rolePermissionOverrides.id) }).from(rolePermissionOverrides).groupBy(rolePermissionOverrides.permKey);
  const ids = latest.map(row => row.id).filter((id): id is number => id !== null);
  if (!ids.length) return [];
  const rows = await db.select().from(rolePermissionOverrides).where(inArray(rolePermissionOverrides.id, ids));
  return rows.map(row => ({ permKey: row.permKey, roles: safeRoles(row.roles), createdByUserId: row.createdByUserId, createdAt: row.createdAt }));
}
function safeRoles(text: string): string[] { try { const value = JSON.parse(text); return Array.isArray(value) ? value.map(String) : []; } catch { return []; } }

export function toRawOverrides(rows: PermissionOverrideRow[]) {
  const raw = { capabilities: {} as Record<string, string[]> };
  for (const row of rows) raw.capabilities[row.permKey] = row.roles;
  return raw;
}

/** Recarrega do banco e aplica (com o piso fixo da sanitização). Serializado: recargas concorrentes terminam no estado mais recente. */
let queue: Promise<unknown> = Promise.resolve();
export function reloadPermissionOverrides(db: Db): Promise<void> {
  const run = async () => { setPermissionOverrides(toRawOverrides(await latestPermissionOverrides(db))); };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** BOOT: flag desligada = nada; falha (tabela ausente) mantém os padrões e só avisa (fail-closed para o fallback: valores de hoje). */
export async function applyPersistedPermissionOverrides(db: Db | null | undefined): Promise<void> {
  if (!ENV.permissionOverridesEnabled || !db) return;
  try { await reloadPermissionOverrides(db); } catch (error) { logger.warn("Permission overrides not applied; defaults kept", { errorName: error instanceof Error ? error.name : "non-Error" }); }
}
