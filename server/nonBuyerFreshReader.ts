import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

/**
 * Leitor "fresco" da elegibilidade (C2/C3 fatia 4): pool DEDICADO e pequeno, só para as leituras simples (autocommit, sem transação, nunca segura lock) que o gancho faz
 * depois de travar o estado. Se usasse o pool principal da aplicação (limite 10), N ganchos segurando uma conexão com tx+locks e pedindo uma segunda esgotariam o pool e
 * travariam sem timeout. Aqui a espera é curta (leitura de milissegundos) e limitada por FRESH_READ_TIMEOUT_MS: estourou, o gancho falha e a reconciliação cobre.
 */
export const FRESH_POOL_SIZE = 3;
export const FRESH_READ_TIMEOUT_MS = 3000;

export class FreshReadTimeout extends Error { constructor() { super("Leitura fresca da elegibilidade excedeu o tempo."); this.name = "FreshReadTimeout"; } }

type FreshDb = MySql2Database<Record<string, unknown>>;
let pool: mysql.Pool | undefined;
let db: FreshDb | undefined;

export function getFreshReader(url: string | undefined = process.env.DATABASE_URL): FreshDb | undefined {
  if (db) return db;
  if (!url) return undefined;
  pool = mysql.createPool({ uri: url, connectionLimit: FRESH_POOL_SIZE, waitForConnections: true, queueLimit: 100, enableKeepAlive: true });
  db = drizzle({ client: pool }) as unknown as FreshDb;
  return db;
}

export async function closeFreshReader() {
  const current = pool;
  pool = undefined; db = undefined;
  await current?.end();
}

/** Limita a espera total (fila do pool + consulta); a consulta perdedora termina sozinha e devolve a conexão. */
export async function withFreshTimeout<T>(work: Promise<T>, ms: number = FRESH_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FreshReadTimeout()), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
