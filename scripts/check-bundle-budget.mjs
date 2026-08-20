import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const assetsDir = resolve("dist/public/assets");
const files = readdirSync(assetsDir);
const rules = [
  { name: "aplicação crítica", match: /^index-[A-Za-z0-9_-]+\.js$/, maxGzipKb: 450 },
  { name: "exportação Excel lazy", match: /^exceljs.*\.js$/, maxGzipKb: 300 },
  { name: "exportação PDF lazy", match: /^jspdf.*\.js$/, maxGzipKb: 150 },
];

for (const rule of rules) {
  const file = files.find(name => rule.match.test(name));
  if (!file) throw new Error(`Asset ausente no orçamento: ${rule.name}`);
  const gzipKb = gzipSync(readFileSync(resolve(assetsDir, file))).length / 1024;
  console.log(`${rule.name}: ${file} = ${gzipKb.toFixed(1)} KB gzip (limite ${rule.maxGzipKb} KB)`);
  if (gzipKb > rule.maxGzipKb) throw new Error(`Orçamento excedido: ${rule.name}`);
}
