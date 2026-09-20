import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

const configUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "..", "playwright.config.ts"),
);

async function loadPlaywrightConfig() {
  const moduleUrl = `${configUrl.href}?test=${crypto.randomUUID()}`;
  return (await import(moduleUrl)).default;
}

describe("Playwright server lifecycle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("starts the local server when E2E_BASE_URL selects the target URL", async () => {
    vi.stubEnv("E2E_BASE_URL", "http://127.0.0.1:4173");
    vi.stubEnv("E2E_EXTERNAL_SERVER", "0");
    vi.stubEnv("DATABASE_URL", "mysql://root@127.0.0.1:43336/tgr_crm_test_e2e");
    vi.stubEnv("JWT_SECRET", "synthetic-test-secret-with-at-least-32-characters");
    vi.stubEnv("VITE_APP_ID", "tgr-e2e");
    vi.stubEnv("OWNER_OPEN_ID", "E2E-TGR-test-OWNER");

    const config = await loadPlaywrightConfig();

    expect(config.use.baseURL).toBe("http://127.0.0.1:4173");
    expect(config.webServer).toMatchObject({
      command: "node --import tsx server/_core/index.ts",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      env: {
        NODE_ENV: "development",
        PORT: "4173",
        DATABASE_URL: "mysql://root@127.0.0.1:43336/tgr_crm_test_e2e",
        JWT_SECRET: "synthetic-test-secret-with-at-least-32-characters",
        VITE_APP_ID: "tgr-e2e",
        OWNER_OPEN_ID: "E2E-TGR-test-OWNER",
      },
    });
  });

  test("uses an externally managed server only when explicitly requested", async () => {
    vi.stubEnv("E2E_BASE_URL", "http://127.0.0.1:4173");
    vi.stubEnv("E2E_EXTERNAL_SERVER", "1");

    const config = await loadPlaywrightConfig();

    expect(config.webServer).toBeUndefined();
  });
});
