import { readFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// KAN-31: o último snapshot do drizzle precisa descrever exatamente as FKs que as migrations
// criam no banco. Se divergir, um `drizzle-kit generate/push` futuro propõe DROP de FK real.
// Pré-condição: banco isolado já migrado do zero (`drizzle-kit migrate`).
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const root = path.resolve(import.meta.dirname, "..");

function latestSnapshot() {
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const last = journal.entries[journal.entries.length - 1];
  const prefix = last.tag.split("_")[0];
  return JSON.parse(readFileSync(path.join(root, `drizzle/meta/${prefix}_snapshot.json`), "utf8")) as {
    tables: Record<string, { foreignKeys?: Record<string, { name: string }> }>;
  };
}

describe.skipIf(!integrationUrl)("drift entre snapshot drizzle e banco migrado", () => {
  let connection: mysql.Connection;
  let schemaName: string;

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    connection = await mysql.createConnection({ uri: integrationUrl });
    schemaName = new URL(integrationUrl!).pathname.replace(/^\//, "");
  });

  afterAll(async () => {
    await connection?.end();
  });

  it("FKs (tabela, nome) do banco == FKs do último snapshot", async () => {
    const [rows] = await connection.query(
      "SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?",
      [schemaName],
    );
    const inDb = (rows as { t: string; n: string }[]).map(r => `${r.t}.${r.n}`).sort();
    const inSnapshot = Object.entries(latestSnapshot().tables)
      .flatMap(([table, def]) => Object.values(def.foreignKeys ?? {}).map(fk => `${table}.${fk.name}`))
      .sort();
    expect(inSnapshot).toEqual(inDb);
  });
});
