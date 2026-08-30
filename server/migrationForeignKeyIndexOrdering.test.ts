import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function readMigration(name: string) {
  return readFileSync(path.join(root, "drizzle", name), "utf8");
}

describe("inventory unique-index migration ordering", () => {
  test("creates the replacement unique index before dropping the FK-supporting index", () => {
    const initialInventorySchema = readMigration("0001_burly_blur.sql");
    const migration = readMigration("0026_inventory-unique-constraints.sql");

    expect(initialInventorySchema).toContain(
      "FOREIGN KEY (`resortId`) REFERENCES `resorts`(`id`)",
    );
    expect(initialInventorySchema).toContain(
      "CREATE INDEX `units_resort_code_idx` ON `units` (`resortId`,`code`)",
    );

    const replacementUniqueIndex = migration.indexOf(
      "ALTER TABLE `units` ADD CONSTRAINT `units_resort_code_unique` UNIQUE(`resortId`,`code`)",
    );
    const obsoleteIndexDrop = migration.indexOf(
      "DROP INDEX `units_resort_code_idx` ON `units`",
    );

    expect(replacementUniqueIndex).toBeGreaterThanOrEqual(0);
    expect(obsoleteIndexDrop).toBeGreaterThanOrEqual(0);
    expect(replacementUniqueIndex).toBeLessThan(obsoleteIndexDrop);
  });
});
