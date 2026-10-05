import type mysql from "mysql2/promise";

// Inventário SINTÉTICO do laboratório (12 UHs x 10 cotas = 120 frações; valores fictícios).
// Preço e tabela são fixture "NÃO APROVADO" — nunca usar como política comercial real.
export const SYNTHETIC_PILOT = {
  resortExternalKey: "SYN-RESORT-LAB",
  resortName: "SYN Resort Laboratório (sintético)",
  units: 12,
  quotasPerUnit: 10,
  listPrice: "19750.00",
  priceTableVersion: "SYN-NAO-APROVADO",
} as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** Idempotente: INSERT IGNORE sobre as chaves únicas (resort externalKey, unit resort+code, fraction resort+code). */
export async function seedSyntheticPilot(db: mysql.Connection | mysql.Pool) {
  const p = SYNTHETIC_PILOT;
  await db.query("INSERT IGNORE INTO resorts (externalKey, name, city, state, status) VALUES (?, ?, 'Natal', 'RN', 'active')", [p.resortExternalKey, p.resortName]);
  const [[resort]] = await db.query("SELECT id FROM resorts WHERE externalKey = ?", [p.resortExternalKey]) as [Array<{ id: number }>, unknown];

  const unitRows = Array.from({ length: p.units }, (_, i) => [resort.id, `SYN-UH-${pad(i + 1)}`, "SYN", 4, 2, "active"]);
  await db.query("INSERT IGNORE INTO units (resortId, code, category, capacity, beds, status) VALUES ?", [unitRows]);
  const [units] = await db.query("SELECT id, code FROM units WHERE resortId = ? AND code LIKE 'SYN-UH-%' ORDER BY code", [resort.id]) as [Array<{ id: number; code: string }>, unknown];

  const fractionRows = units.flatMap(u =>
    Array.from({ length: p.quotasPerUnit }, (_, q) => [resort.id, u.id, `${u.code}-C${pad(q + 1)}`, q + 1, "available", p.listPrice, p.priceTableVersion]),
  );
  for (let i = 0; i < fractionRows.length; i += 520) {
    await db.query(
      "INSERT IGNORE INTO commercial_fractions (resortId, unitId, code, sequence, status, listPrice, priceTableVersion) VALUES ?",
      [fractionRows.slice(i, i + 520)],
    );
  }
  return { resortId: resort.id, units: units.length, fractions: fractionRows.length };
}
