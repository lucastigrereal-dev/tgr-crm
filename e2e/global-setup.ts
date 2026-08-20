import { chromium, type FullConfig } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { COOKIE_NAME } from "../shared/const";
import { sdk } from "../server/_core/sdk";

export default async function globalSetup(config: FullConfig) {
  const openId = process.env.OWNER_OPEN_ID;
  if (!openId) throw new Error("OWNER_OPEN_ID é necessário para a fixture autenticada de navegador.");
  const baseURL = String(config.projects[0]?.use.baseURL || "http://127.0.0.1:3000");
  const token = await sdk.createSessionToken(openId, { name: process.env.OWNER_NAME || "TSE E2E Owner", expiresInMs: 5 * 60_000 });
  await mkdir("e2e/.auth", { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([{ name: COOKIE_NAME, value: token, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
  await context.storageState({ path: "e2e/.auth/owner.json" });
  await browser.close();
}
