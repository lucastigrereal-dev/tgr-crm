import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
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
      OWNER_OPEN_ID: "E2E-TGR-OWNER",
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
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("E2E_CONFIRM_ISOLATED");
    expect(result.output).not.toMatch(/ECONNREFUSED|connect/i);
  });
});
