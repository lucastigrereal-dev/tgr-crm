import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("package scripts", () => {
  test("starts the development server with a cross-platform environment assignment", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts.dev).toBe(
      "cross-env NODE_ENV=development tsx watch server/_core/index.ts",
    );
  });
});
