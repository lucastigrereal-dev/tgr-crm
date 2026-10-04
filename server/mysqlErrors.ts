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
