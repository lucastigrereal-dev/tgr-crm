import mysql from "mysql2/promise";

/**
 * Teste-only: o pump do Financial drena TODOS os eventos pendentes do banco compartilhado. Arquivos de teste que o usam rodam em paralelo e se atrapalhavam
 * (recibos e contagens trocados). Um GET_LOCK do MySQL serializa só esses arquivos; o lock cai sozinho se o processo morrer.
 */
export async function acquireFinancialPumpTestLock(url: string) {
  const connection = await mysql.createConnection(url);
  const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT GET_LOCK('tgr-test-financial-pump', 600) AS got");
  if (Number(rows[0]?.got) !== 1) { await connection.end(); throw new Error("Não obteve o lock de teste do pump do Financial."); }
  return async () => { try { await connection.query("SELECT RELEASE_LOCK('tgr-test-financial-pump')"); } finally { await connection.end(); } };
}
