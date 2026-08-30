import mysql from "mysql2/promise";
import { assertIsolatedE2EEnvironment } from "./e2e-isolation-lib.mjs";
import { getE2EFixtureContext } from "./e2e-fixture-lib.mjs";

const isolation = assertIsolatedE2EEnvironment();
const fixture = getE2EFixtureContext(process.env, isolation);
const db = await mysql.createConnection(fixture.serverUrl);

try {
  await db.query(
    `CREATE DATABASE IF NOT EXISTS ${fixture.quotedDatabaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  const [created] = await db.execute(
    "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?",
    [fixture.databaseName],
  );
  if (created.length !== 1) {
    throw new Error(`Falha ao criar o banco descartável ${fixture.databaseName}.`);
  }
  console.log(
    JSON.stringify({
      event: "e2e.database.prepared",
      runId: fixture.runId,
      database: fixture.databaseName,
    }),
  );
} finally {
  await db.end().catch(() => undefined);
}
