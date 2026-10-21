// drizzle-orm >= 0.44 envolve o erro do mysql2 em DrizzleQueryError e guarda o
// original em `cause`. Inspecionar só o topo faz corrida de idempotência virar 5xx.
export function isDuplicateKeyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (candidate.code === "ER_DUP_ENTRY" || Number(candidate.code) === 1062 || Number(candidate.errno) === 1062) return true;
    current = candidate.cause;
  }
  return false;
}

// Updates/deletes do drizzle+mysql2 resolvem para [ResultSetHeader, fields]; os
// mocks de teste usam { affectedRows }. Aceita os dois e devolve null se não houver
// contagem. mysql2 usa FOUND_ROWS: conta linhas casadas, não só alteradas.
export function affectedRows(result: unknown): number | null {
  const header = Array.isArray(result) ? result[0] : result;
  if (!header || typeof header !== "object" || !("affectedRows" in header)) return null;
  const count = Number((header as { affectedRows: unknown }).affectedRows);
  return Number.isFinite(count) ? count : null;
}

// Delete barrado por chave estrangeira (ER_ROW_IS_REFERENCED_2, 1451): a linha ainda tem dependente.
export function isForeignKeyBlockError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (candidate.code === "ER_ROW_IS_REFERENCED_2" || Number(candidate.errno) === 1451) return true;
    current = candidate.cause;
  }
  return false;
}

// Deadlock do InnoDB (ER_LOCK_DEADLOCK, 1213): o MySQL desfez a transação inteira e manda repetir.
export function isDeadlockError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (candidate.code === "ER_LOCK_DEADLOCK" || Number(candidate.errno) === 1213) return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * Repete a transação quando o MySQL a derruba por deadlock (a recomendação do próprio InnoDB). O callback roda do zero a
 * cada tentativa, então não pode acumular estado de fora entre tentativas. Qualquer outro erro sobe na hora.
 */
export async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isDeadlockError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
    }
  }
}

// Lock wait timeout (ER_LOCK_WAIT_TIMEOUT, 1205): com innodb_rollback_on_timeout=ON o MySQL também desfaz a transação inteira.
export function isLockWaitTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (candidate.code === "ER_LOCK_WAIT_TIMEOUT" || Number(candidate.errno) === 1205) return true;
    current = candidate.cause;
  }
  return false;
}

// Tabela inexistente (ER_NO_SUCH_TABLE, 1146): migration proposta ainda não aplicada.
export function isMissingTableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (candidate.code === "ER_NO_SUCH_TABLE" || Number(candidate.errno) === 1146) return true;
    current = candidate.cause;
  }
  return false;
}
