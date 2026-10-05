import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { SYNTHETIC_PILOT, seedSyntheticPilot } from "./syntheticPilotSeed";

// KAN-31: inventário sintético do laboratório (12 UHs x 10 cotas = 120 frações; valores fictícios).
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;

describe.skipIf(!integrationUrl)("seed sintético do laboratório em MySQL real", () => {
  let connection: mysql.Connection;

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, process.env.DATABASE_URL);
    connection = await mysql.createConnection({ uri: integrationUrl });
  });

  afterAll(async () => {
    await connection?.end();
  });

  async function counts() {
    const [[row]] = await connection.query(
      `SELECT (SELECT COUNT(*) FROM resorts WHERE externalKey = ?) AS resorts,
              (SELECT COUNT(*) FROM units u JOIN resorts r ON r.id = u.resortId WHERE r.externalKey = ?) AS units,
              (SELECT COUNT(*) FROM commercial_fractions f JOIN resorts r ON r.id = f.resortId WHERE r.externalKey = ?) AS fractions,
              (SELECT COUNT(*) FROM commercial_fractions f JOIN resorts r ON r.id = f.resortId WHERE r.externalKey = ? AND f.status = 'available') AS available`,
      Array(4).fill(SYNTHETIC_PILOT.resortExternalKey),
    ) as [Array<Record<string, number>>, unknown];
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  }

  it("cria 1 resort SYN, 12 UHs e 120 frações disponíveis", async () => {
    const result = await seedSyntheticPilot(connection);
    expect(result).toMatchObject({ units: 12, fractions: 120 });
    expect(await counts()).toEqual({ resorts: 1, units: 12, fractions: 120, available: 120 });
  });

  it("é idempotente: rodar de novo não duplica nada", async () => {
    await seedSyntheticPilot(connection);
    expect(await counts()).toEqual({ resorts: 1, units: 12, fractions: 120, available: 120 });
  });

  it("marca preço e tabela como fixture NÃO APROVADO e códigos SYN-*", async () => {
    const [rows] = await connection.query(
      `SELECT DISTINCT f.priceTableVersion AS v, f.listPrice AS p FROM commercial_fractions f JOIN resorts r ON r.id = f.resortId WHERE r.externalKey = ?`,
      [SYNTHETIC_PILOT.resortExternalKey],
    ) as [Array<{ v: string; p: string }>, unknown];
    expect(rows).toEqual([{ v: "SYN-NAO-APROVADO", p: "19750.00" }]);
    const [[sample]] = await connection.query(
      `SELECT f.code FROM commercial_fractions f JOIN units u ON u.id = f.unitId JOIN resorts r ON r.id = f.resortId WHERE r.externalKey = ? AND u.code = 'SYN-UH-12' AND f.sequence = 10`,
      [SYNTHETIC_PILOT.resortExternalKey],
    ) as [Array<{ code: string }>, unknown];
    expect(sample.code).toBe("SYN-UH-12-C10");
  });
});
