const CONFIRMATION_VALUE = "I_CONFIRM_ISOLATED_E2E";
const SAFE_DATABASE_SUFFIX = /(?:_e2e|_test|_staging)$/i;

function parseMysqlUrl(value, variableName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} deve ser uma URL MySQL válida.`);
  }

  if (parsed.protocol !== "mysql:") {
    throw new Error(`${variableName} deve usar o protocolo MySQL (mysql://).`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!database || database.includes("/")) {
    throw new Error(`${variableName} deve apontar para um único banco MySQL explícito.`);
  }

  return { parsed, database };
}

function databaseIdentity(parsed, database) {
  return [
    parsed.protocol.toLowerCase(),
    parsed.hostname.toLowerCase(),
    parsed.port || "3306",
    database.toLowerCase(),
  ].join("|");
}

export function assertIsolatedE2EEnvironment(env = process.env) {
  const e2eUrl = env.E2E_DATABASE_URL;
  if (!e2eUrl) {
    throw new Error("E2E_DATABASE_URL é obrigatória para E2E estrito.");
  }

  const e2e = parseMysqlUrl(e2eUrl, "E2E_DATABASE_URL");

  if (env.E2E_CONFIRM_ISOLATED !== CONFIRMATION_VALUE) {
    throw new Error(
      `Defina E2E_CONFIRM_ISOLATED=${CONFIRMATION_VALUE} para autorizar fixtures descartáveis.`,
    );
  }

  if (!SAFE_DATABASE_SUFFIX.test(e2e.database)) {
    throw new Error(
      "O banco de E2E deve terminar em _e2e, _test ou _staging.",
    );
  }

  const operationalUrl = env.DATABASE_URL;
  if (operationalUrl) {
    const operational = parseMysqlUrl(operationalUrl, "DATABASE_URL");
    if (
      databaseIdentity(e2e.parsed, e2e.database) ===
      databaseIdentity(operational.parsed, operational.database)
    ) {
      throw new Error(
        "E2E_DATABASE_URL não pode apontar para o banco operacional, mesmo com credenciais ou parâmetros diferentes.",
      );
    }
  }

  return {
    url: e2eUrl,
    hostname: e2e.parsed.hostname,
    port: e2e.parsed.port || "3306",
    database: e2e.database,
  };
}
