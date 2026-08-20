export function validateIsolatedE2EDatabase(url: string | undefined, productionUrl?: string) {
  if (!url) throw new Error("E2E_DATABASE_URL é obrigatória para E2E estrito.");
  if (productionUrl && url === productionUrl) throw new Error("E2E_DATABASE_URL não pode apontar para o banco operacional.");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("E2E_DATABASE_URL inválida."); }
  const database = parsed.pathname.replace(/^\//, "");
  if (!/(?:_e2e|_test|_staging)$/i.test(database)) throw new Error("O banco de E2E deve terminar em _e2e, _test ou _staging.");
  return { host: parsed.hostname, database };
}
