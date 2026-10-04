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
