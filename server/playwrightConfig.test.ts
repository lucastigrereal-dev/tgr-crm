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

    const config = await loadPlaywrightConfig();

    expect(config.use.baseURL).toBe("http://127.0.0.1:4173");
    expect(config.webServer).toMatchObject({
      command: "pnpm dev",
      url: "http://127.0.0.1:4173",
      env: { PORT: "4173" },
    });
  });

  test("uses an externally managed server only when explicitly requested", async () => {
    vi.stubEnv("E2E_BASE_URL", "http://127.0.0.1:4173");
    vi.stubEnv("E2E_EXTERNAL_SERVER", "1");

    const config = await loadPlaywrightConfig();

    expect(config.webServer).toBeUndefined();
  });
});
