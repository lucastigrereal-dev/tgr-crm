import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function runDoctor(overrides: Record<string, string | undefined>) {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const result = spawnSync(
    process.execPath,
    ["scripts/config-doctor.mjs", "--e2e", "--strict"],
    {
      cwd: root,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 5_000,
    },
  );

  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

const validRuntime = {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/tgr_crm_ci_e2e",
  JWT_SECRET: "ci-only-secret-with-at-least-32-characters",
  VITE_APP_ID: "tgr-e2e",
  OAUTH_SERVER_URL: "http://127.0.0.1:65535",
  OWNER_OPEN_ID: "E2E-TGR-ci-OWNER",
};

describe("config doctor E2E strict profile", () => {
  test("keeps the E2E profile when --e2e and --strict are combined", () => {
    const result = runDoctor({
      ...validRuntime,
      E2E_STRICT: "0",
      E2E_DATABASE_URL: undefined,
      E2E_RUN_ID: undefined,
      E2E_CONFIRM_ISOLATED: undefined,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("perfil=e2e");
    expect(result.output).toContain("E2E_DATABASE_URL ausente");
  });

  test("requires run ownership and explicit isolation confirmation in strict E2E", () => {
    const result = runDoctor({
      ...validRuntime,
      E2E_STRICT: "1",
      E2E_DATABASE_URL: validRuntime.DATABASE_URL,
      E2E_RUN_ID: undefined,
      E2E_CONFIRM_ISOLATED: undefined,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("E2E_RUN_ID ausente");
    expect(result.output).toContain("E2E_CONFIRM_ISOLATED");
  });
});
