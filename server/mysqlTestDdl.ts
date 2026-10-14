import type mysql from "mysql2/promise";

/**
 * DDL de trigger nos testes MySQL em paralelo: o CREATE/DROP TRIGGER pede trava exclusiva de metadados em domain_events e, na fila,
 * bloqueia todo INSERT que chega depois. Com o lock_wait_timeout padrão (1 ano), um teste que segura uma transação aberta na tabela
 * (commit tardio das pontes) vira espera circular até o timeout do vitest. Aqui o DDL desiste em 2 s, libera a fila e tenta de novo
 * (4 tentativas, abaixo do hookTimeout de 10 s; a sessão volta ao padrão antes de a conexão voltar ao pool).
 */
export async function runTriggerDdl(pool: mysql.Pool, statement: string, attempts = 4) {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET SESSION lock_wait_timeout = 2");
    for (let attempt = 1; ; attempt += 1) {
      try { await conn.query(statement); return; } catch (error) {
        if ((error as { errno?: number }).errno !== 1205 || attempt >= attempts) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  } finally {
    await conn.query("SET SESSION lock_wait_timeout = DEFAULT").catch(() => undefined);
    conn.release();
  }
}
