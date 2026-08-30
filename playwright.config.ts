import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";
const useExternalServer = process.env.E2E_EXTERNAL_SERVER === "1";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  outputDir: "test-results/artifacts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    storageState: "e2e/.auth/owner.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: useExternalServer ? undefined : {
    command: "pnpm dev",
    url: baseURL,
    env: { PORT: new URL(baseURL).port || "3000" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
