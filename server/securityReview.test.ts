import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSessionCookieOptions } from "./_core/cookies";
import { applySecurityHeaders, createOriginGuard } from "./securityHeaders";

// CRM-A26: achados da revisão de segurança formal (docs/audit/REVISAO_SEGURANCA_CRM_2026-10-20.md) com prova.
function appWith(origin: { enabled: boolean; allowedOrigins?: string[] }) {
  const app = express();
  app.use(applySecurityHeaders);
  app.use(createOriginGuard(origin));
  app.get("/api/trpc/x", (_req, res) => { res.json({ ok: true }); });
  app.post("/api/trpc/x", (_req, res) => { res.json({ ok: true }); });
  app.get("/api/realtime", (_req, res) => { res.setHeader("Cache-Control", "no-cache, no-transform"); res.end("ok"); });
  app.get("/assets/app.js", (_req, res) => { res.type("js").send("1"); });
  app.get("/login", (req, res) => {
    res.cookie("app_session_id", "synthetic", { ...getSessionCookieOptions(req), maxAge: 1000 });
    res.end("ok");
  });
  return app;
}

async function listen(app: express.Express) {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, base: "http://127.0.0.1:" + (server.address() as AddressInfo).port };
}

describe("revisão de segurança CRM-A26", () => {
  let off: { server: Server; base: string };
  let on: { server: Server; base: string };
  beforeAll(async () => {
    off = await listen(appWith({ enabled: false }));
    on = await listen(appWith({ enabled: true, allowedOrigins: ["https://crm.exemplo.test/"] }));
  });
  afterAll(async () => { await Promise.all([off, on].map(item => new Promise(resolve => item.server.close(resolve)))); });

  it("A26-1: resposta de /api sai com Cache-Control: no-store; rota que já define o seu e estáticos ficam como estão", async () => {
    expect((await fetch(off.base + "/api/trpc/x")).headers.get("cache-control")).toBe("no-store");
    expect((await fetch(off.base + "/api/realtime")).headers.get("cache-control")).toBe("no-cache, no-transform");
    expect((await fetch(off.base + "/assets/app.js")).headers.get("cache-control")).toBeNull();
  });

  it("A26-2: cookie de sessão é HttpOnly + SameSite=Lax e só ganha Secure sob HTTPS (direto ou via proxy)", async () => {
    const plain = (await fetch(off.base + "/login")).headers.get("set-cookie") ?? "";
    expect(plain).toMatch(/HttpOnly/i); expect(plain).toMatch(/SameSite=Lax/i); expect(plain).not.toMatch(/Secure/i);
    const proxied = (await fetch(off.base + "/login", { headers: { "x-forwarded-proto": "https" } })).headers.get("set-cookie") ?? "";
    expect(proxied).toMatch(/Secure/i); expect(proxied).toMatch(/SameSite=Lax/i); expect(proxied).not.toMatch(/SameSite=None/i);
  });

  it("A26-3: guarda de origem desligada por padrão deixa tudo passar", async () => {
    const response = await fetch(off.base + "/api/trpc/x", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(200);
  });

  it("A26-3: guarda ligada recusa Origin de terceiros em mutação e libera mesma origem, lista permitida, leitura e cliente sem Origin", async () => {
    const post = (headers: Record<string, string>) => fetch(on.base + "/api/trpc/x", { method: "POST", headers });
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await post({ origin: on.base })).status).toBe(200);
    expect((await post({ origin: "https://crm.exemplo.test" })).status).toBe(200);
    expect((await post({})).status).toBe(200);
    expect((await fetch(on.base + "/api/trpc/x", { headers: { origin: "https://evil.example" } })).status).toBe(200);
  });
});
