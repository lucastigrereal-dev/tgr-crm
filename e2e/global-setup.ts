import { chromium, type FullConfig } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { COOKIE_NAME } from "../shared/const";
import { getE2EFixture } from "../shared/e2eFixture";
import { sdk } from "../server/_core/sdk";

export default async function globalSetup(config: FullConfig) {
  const fixture = getE2EFixture();
  const openId = process.env.OWNER_OPEN_ID || fixture.ownerOpenId;
  if (openId !== fixture.ownerOpenId) {
    throw new Error(`OWNER_OPEN_ID deve ser ${fixture.ownerOpenId} neste run E2E.`);
  }
  const baseURL = String(
    config.projects[0]?.use.baseURL || "http://127.0.0.1:3000",
  );
  const token = await sdk.createSessionToken(openId, {
    name: fixture.ownerName,
    expiresInMs: 15 * 60_000,
  });
  await mkdir("e2e/.auth", { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.storageState({ path: "e2e/.auth/owner.json" });
  await browser.close();
}
