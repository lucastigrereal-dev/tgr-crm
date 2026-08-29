import mysql from "mysql2/promise";
import { assertIsolatedE2EEnvironment } from "./e2e-isolation-lib.mjs";
import { getE2EFixtureContext } from "./e2e-fixture-lib.mjs";

if (!process.env.E2E_RUN_ID) {
  throw new Error("E2E_RUN_ID é obrigatório para remover somente o banco deste run.");
}

const isolation = assertIsolatedE2EEnvironment();
const fixture = getE2EFixtureContext(process.env, isolation);
const db = await mysql.createConnection(fixture.serverUrl);

try {
  await db.query(`DROP DATABASE IF EXISTS ${fixture.quotedDatabaseName}`);
  const [remaining] = await db.execute("SHOW DATABASES LIKE ?", [fixture.databaseName]);
  if (remaining.length !== 0) {
    throw new Error(`Falha ao remover o banco descartável ${fixture.databaseName}.`);
  }
  console.log(
    JSON.stringify({
      event: "e2e.cleanup.completed",
      runId: fixture.runId,
      database: fixture.databaseName,
    }),
  );
} finally {
  await db.end().catch(() => undefined);
}
