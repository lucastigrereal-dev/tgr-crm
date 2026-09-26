import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getClicksignConfig, verifyClicksignWebhook } from "./clicksign";

describe("Clicksign adapter security", () => {
  it("verifies the raw-body HMAC with timing-safe comparison", () => {
    const raw = Buffer.from(JSON.stringify({ event: { name: "document_closed" }, document: { id: "doc-1" } }));
    const secret = "super-secret";
    const digest = createHmac("sha256", secret).update(raw).digest("hex");

    expect(verifyClicksignWebhook(raw, digest, secret)).toBe(true);
    expect(verifyClicksignWebhook(raw, `sha256=${digest}`, secret)).toBe(true);
    expect(verifyClicksignWebhook(Buffer.from("tampered"), digest, secret)).toBe(false);
    expect(verifyClicksignWebhook(raw, "not-a-digest", secret)).toBe(false);
  });

  it("defaults to sandbox outside production but refuses an implicit production endpoint", () => {
    expect(getClicksignConfig({
      NODE_ENV: "test",
      CLICKSIGN_API_TOKEN: "token",
      CLICKSIGN_WEBHOOK_SECRET: "secret",
    } as NodeJS.ProcessEnv)).toMatchObject({ baseUrl: "https://sandbox.clicksign.com" });

    expect(getClicksignConfig({
      NODE_ENV: "production",
      CLICKSIGN_API_TOKEN: "token",
      CLICKSIGN_WEBHOOK_SECRET: "secret",
    } as NodeJS.ProcessEnv)).toBeNull();

    expect(getClicksignConfig({
      NODE_ENV: "production",
      CLICKSIGN_API_TOKEN: "token",
      CLICKSIGN_WEBHOOK_SECRET: "secret",
      CLICKSIGN_API_URL: "https://app.clicksign.com",
    } as NodeJS.ProcessEnv)).toMatchObject({ baseUrl: "https://app.clicksign.com" });
  });
});
