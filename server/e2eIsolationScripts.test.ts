import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function runScript(
  script: string,
  overrides: Record<string, string | undefined>,
) {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 5_000,
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function readRepoFile(relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

const confirmedBaseEnv = {
  DATABASE_URL: undefined,
  E2E_DATABASE_URL: "mysql://user:pass@127.0.0.1:9/tgr_crm_e2e",
  E2E_CONFIRM_ISOLATED: "I_CONFIRM_ISOLATED_E2E",
};

describe("E2E isolation scripts", () => {
  test("rejects a non-MySQL E2E database URL", () => {
    const result = runScript("scripts/check-e2e-isolation.mjs", {
      DATABASE_URL: undefined,
      E2E_DATABASE_URL: "postgresql://user:pass@127.0.0.1/tgr_crm_e2e",
      E2E_CONFIRM_ISOLATED: "I_CONFIRM_ISOLATED_E2E",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/mysql/i);
  });

  test("rejects the operational database after canonical URL normalization", () => {
    const result = runScript("scripts/check-e2e-isolation.mjs", {
      DATABASE_URL: "mysql://user:pass@127.0.0.1/tgr_crm_e2e?a=1&b=2",
      E2E_DATABASE_URL:
        "mysql://user:pass@127.0.0.1:3306/tgr_crm_e2e?b=2&a=1",
      E2E_CONFIRM_ISOLATED: "I_CONFIRM_ISOLATED_E2E",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/operacional/i);
  });

  test("seed aborts before opening a database connection without explicit confirmation", () => {
    const result = runScript("scripts/seed-e2e-isolated.mjs", {
      DATABASE_URL: undefined,
      E2E_DATABASE_URL: "mysql://user:pass@127.0.0.1:9/tgr_crm_e2e",
      E2E_CONFIRM_ISOLATED: undefined,
      E2E_RUN_ID: "guard-test",
      OWNER_OPEN_ID: "E2E-TGR-guard-test-OWNER",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("E2E_CONFIRM_ISOLATED");
    expect(result.output).not.toMatch(/ECONNREFUSED|connect/i);
  });

  test("cleanup aborts before opening a database connection without explicit confirmation", () => {
    const result = runScript("scripts/cleanup-e2e-isolated.mjs", {
      DATABASE_URL: undefined,
      E2E_DATABASE_URL: "mysql://user:pass@127.0.0.1:9/tgr_crm_e2e",
      E2E_CONFIRM_ISOLATED: undefined,
      E2E_RUN_ID: "guard-test",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("E2E_CONFIRM_ISOLATED");
    expect(result.output).not.toMatch(/ECONNREFUSED|connect/i);
  });

  test("seed requires an explicit fixture run id before opening a connection", () => {
    const result = runScript("scripts/seed-e2e-isolated.mjs", {
      ...confirmedBaseEnv,
      E2E_RUN_ID: undefined,
      OWNER_OPEN_ID: "E2E-TGR-OWNER",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("E2E_RUN_ID");
    expect(result.output).not.toMatch(/ECONNREFUSED|connect/i);
  });

  test("cleanup requires an explicit fixture run id before opening a connection", () => {
    const result = runScript("scripts/cleanup-e2e-isolated.mjs", {
      ...confirmedBaseEnv,
      E2E_RUN_ID: undefined,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("E2E_RUN_ID");
    expect(result.output).not.toMatch(/ECONNREFUSED|connect/i);
  });

  test("cleanup cannot disable foreign keys or issue unqualified table-wide deletes", () => {
    const cleanup = readRepoFile("scripts/cleanup-e2e-isolated.mjs");

    expect(cleanup).not.toMatch(/FOREIGN_KEY_CHECKS/i);
    expect(cleanup).not.toMatch(/DELETE\s+FROM\s+\$\{table\}/i);
    expect(cleanup).not.toMatch(/DELETE\s+FROM\s+[a-z_]+\s*[;`]/i);
    expect(cleanup).toContain("E2E_RUN_ID");
  });

  test("runtime E2E fixtures use the TGR product identity, not TSE residue", () => {
    const runtimeSources = [
      "scripts/seed-e2e-isolated.mjs",
      "e2e/global-setup.ts",
      "e2e/strict-isolated.spec.ts",
    ]
      .map(readRepoFile)
      .join("\n");

    expect(runtimeSources).not.toContain("TSE E2E Owner");
    expect(runtimeSources).toContain("E2E-TGR-");
  });
});
