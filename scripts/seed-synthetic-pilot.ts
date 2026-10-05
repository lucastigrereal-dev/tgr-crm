// Uso: TGR_MYSQL_INTEGRATION_URL=mysql://.../<banco>_e2e pnpm exec tsx scripts/seed-synthetic-pilot.ts
// Só aceita banco isolado (_e2e/_test/_staging) e diferente do DATABASE_URL operacional.
import mysql from "mysql2/promise";
import { validateIsolatedE2EDatabase } from "../server/e2eSafety";
import { seedSyntheticPilot } from "../server/syntheticPilotSeed";

const url = process.env.TGR_MYSQL_INTEGRATION_URL;
validateIsolatedE2EDatabase(url, process.env.DATABASE_URL);
const connection = await mysql.createConnection({ uri: url });
try {
  console.log(JSON.stringify(await seedSyntheticPilot(connection)));
} finally {
  await connection.end();
}
