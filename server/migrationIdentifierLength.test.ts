import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "drizzle");
const MAX_MYSQL_IDENTIFIER_LENGTH = 64;

function quotedIdentifiers(sql: string) {
  const patterns = [
    /CONSTRAINT\s+`([^`]+)`/gi,
    /(?:CREATE\s+(?:UNIQUE\s+)?INDEX|ADD\s+(?:UNIQUE\s+)?INDEX)\s+`([^`]+)`/gi,
  ];
  return patterns.flatMap(pattern =>
    [...sql.matchAll(pattern)].map(match => match[1]),
  );
}

describe("MySQL migration identifiers", () => {
  test("keeps every explicit constraint and index name within MySQL's 64-character limit", () => {
    const violations = readdirSync(migrationsDir)
      .filter(file => /^\d{4}_.+\.sql$/.test(file))
      .flatMap(file => {
        const sql = readFileSync(path.join(migrationsDir, file), "utf8");
        return quotedIdentifiers(sql)
          .filter(identifier => identifier.length > MAX_MYSQL_IDENTIFIER_LENGTH)
          .map(identifier => ({ file, identifier, length: identifier.length }));
      });

    expect(violations).toEqual([]);
  });
});
