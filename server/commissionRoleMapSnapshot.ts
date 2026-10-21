import { desc, eq, sql } from "drizzle-orm";
import { commissionRoleMapVersions, contractCommissionRoleMaps } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { DEFAULT_COMMISSION_V2_ROLE_MAP, parseCommissionRoleMap, type CommissionRoleMap } from "./commissionRoleMap";
import type { getDb } from "./db";
import { logger } from "./logger";
import { isDeadlockError, isLockWaitTimeoutError, isMissingTableError } from "./mysqlErrors";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Writer = Db | Tx;

/** `blocked`: mapa ilegível ou inválido (snapshot ou versão vigente). Quem paga NÃO cai na constante: a comissão fica retida para revisão manual. */
export type RoleMapResolution = { map: CommissionRoleMap } | { blocked: "snapshot_invalid" | "current_invalid" };

const safeJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };

/**
 * Resolve e, se faltar, FIXA o mapa do contrato (insert-if-absent, no-op em corrida) e relê o snapshot com FOR UPDATE: em REPEATABLE READ o SELECT simples não enxerga o
 * commit concorrente de quem inseriu primeiro. Flag OFF: snapshot existente vale; sem snapshot, a constante (sem criar nada). Mapa inválido NUNCA vira constante (bloqueia) e nunca é gravado.
 * Quem chama de dentro do fluxo de comissão já está serializado por parcela (finance.ts trava a linha da PARCELA com FOR UPDATE; o contrato não é travado ali), por isso
 * o insert-if-absent + FOR UPDATE aqui é o que garante um snapshot único por contrato.
 */
export async function resolveContractCommissionRoleMap(tx: Writer, contractId: number): Promise<RoleMapResolution> {
  // Snapshot EXISTENTE vale SEMPRE, com a flag ligada ou desligada (desligar a flag não pode trocar QUEM recebe num contrato que já fixou o mapa). A flag controla só a
  // CRIAÇÃO de snapshot novo e o uso da configuração vigente. Com a flag OFF e a migration 0083 ainda não aplicada (tabela ausente), cai na constante como hoje.
  let existing: typeof contractCommissionRoleMaps.$inferSelect | undefined;
  try {
    [existing] = await tx.select().from(contractCommissionRoleMaps).where(eq(contractCommissionRoleMaps.contractId, contractId)).limit(1);
  } catch (error) {
    if (!ENV.commissionRoleMapEnabled && isMissingTableError(error)) return { map: DEFAULT_COMMISSION_V2_ROLE_MAP };
    throw error;
  }
  if (existing) {
    const parsed = parseCommissionRoleMap(safeJson(existing.roleMap));
    return parsed ? { map: parsed } : { blocked: "snapshot_invalid" };
  }
  if (!ENV.commissionRoleMapEnabled) return { map: DEFAULT_COMMISSION_V2_ROLE_MAP };
  const [current] = await tx.select().from(commissionRoleMapVersions).orderBy(desc(commissionRoleMapVersions.version)).limit(1);
  const map = current ? parseCommissionRoleMap(safeJson(current.roleMap)) : DEFAULT_COMMISSION_V2_ROLE_MAP;
  if (!map) return { blocked: "current_invalid" };
  await tx.insert(contractCommissionRoleMaps).values({ contractId, mapVersion: current?.version ?? 0, roleMap: JSON.stringify(map) }).onDuplicateKeyUpdate({ set: { contractId: sql`contractId` } });
  const [fixed] = await tx.select().from(contractCommissionRoleMaps).where(eq(contractCommissionRoleMaps.contractId, contractId)).limit(1).for("update");
  const parsed = fixed ? parseCommissionRoleMap(safeJson(fixed.roleMap)) : null;
  return parsed ? { map: parsed } : { blocked: "snapshot_invalid" };
}

/**
 * Gancho da FORMALIZAÇÃO do contrato (contracts.create e materializeSalesCommandSale): fixa o mapa vigente na MESMA transação, como último passo. O snapshot nasce com o
 * contrato; salvar uma versão nova depois não muda QUEM recebe neste contrato. Falha comum (tabela ausente) é registrada e engolida num SAVEPOINT (o lançamento ainda
 * resolve/fixa como fallback para contrato sem snapshot); deadlock e lock wait timeout SOBEM (o InnoDB desfez a tx inteira; engolir seria perda silenciosa do contrato).
 */
export async function fixContractCommissionRoleMapAtFormalization(tx: Tx, contractId: number): Promise<void> {
  if (!ENV.commissionRoleMapEnabled) return;
  let original: unknown;
  try {
    await tx.transaction(async inner => {
      try { const resolution = await resolveContractCommissionRoleMap(inner as unknown as Tx, contractId); if ("blocked" in resolution) logger.warn("Commission role map not fixed at formalization", { contractId, reason: resolution.blocked }); } catch (error) { original = error; throw error; }
    });
  } catch (error) {
    const fatal = [original, error].find(candidate => candidate !== undefined && (isDeadlockError(candidate) || isLockWaitTimeoutError(candidate)));
    if (fatal !== undefined) throw fatal;
    if (original !== undefined && error !== original) throw error; // o ROLLBACK TO SAVEPOINT falhou: a tx está inutilizável
    logger.warn("Commission role map snapshot failed at formalization; payment will fix it", { contractId, errorName: error instanceof Error ? error.name : "non-Error" });
  }
}
