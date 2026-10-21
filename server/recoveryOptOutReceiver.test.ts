import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { describe, expect, it } from "vitest";
import { RECOVERY_OPTOUT_PATH, recoveryOptOutHash, recoveryOptOutSchema, registerRecoveryOptOutGate } from "./recoveryOptOutReceiver";

const base = { eventId: "rec-evt-1", coupleCode: "TGR-0001", optedOutAt: "2026-10-21T15:00:00.000Z", source: "recovery" as const };

describe("recovery.opted_out.v1: contrato do receptor", () => {
  it("aceita o corpo estrito e recusa campo extra, origem errada, instante fora da faixa e texto de controle", () => {
    expect(recoveryOptOutSchema.safeParse(base).success).toBe(true);
    expect(recoveryOptOutSchema.safeParse({ ...base, phone: "1" }).success).toBe(false);
    expect(recoveryOptOutSchema.safeParse({ ...base, source: "sales-command" }).success).toBe(false);
    expect(recoveryOptOutSchema.safeParse({ ...base, optedOutAt: "1999-01-01T00:00:00Z" }).success).toBe(false);
    expect(recoveryOptOutSchema.safeParse({ ...base, optedOutAt: "ontem" }).success).toBe(false);
    expect(recoveryOptOutSchema.safeParse({ ...base, coupleCode: "A\u0000B" }).success).toBe(false);
    expect(recoveryOptOutSchema.safeParse({ ...base, eventId: "" }).success).toBe(false);
    expect(recoveryOptOutSchema.safeParse({ ...base, coupleCode: "X".repeat(65) }).success).toBe(false);
  });
  it("o hash muda com qualquer campo", () => {
    const h = recoveryOptOutHash(base);
    expect(recoveryOptOutHash({ ...base })).toBe(h);
    expect(recoveryOptOutHash({ ...base, optedOutAt: "2026-10-21T15:00:01.000Z" })).not.toBe(h);
    expect(recoveryOptOutHash({ ...base, coupleCode: "OUTRO" })).not.toBe(h);
  });
  it("portão antes do parser global: sem chave 401 mesmo com JSON ruim; com chave JSON ruim 400; flag off ou sem chave configurada 404; outras rotas intactas", async () => {
    const mount = async (key: string | undefined, enabled: boolean) => {
      const app = express();
      registerRecoveryOptOutGate(app, key, enabled);
      app.use(express.json({ limit: "12mb" }));
      app.post(RECOVERY_OPTOUT_PATH, (_req, res) => res.status(201).json({ reached: true }));
      app.post("/outra", (req, res) => res.json({ got: req.body }));
      const server = createServer(app);
      await new Promise<void>(resolve => server.listen(0, resolve));
      return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    };
    const send = (b: string, route: string, body: string, key?: string) => fetch(b + route, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body });
    const on = await mount("chave-r", true), off = await mount("chave-r", false), noKey = await mount("", true);
    try {
      expect((await send(on.base, RECOVERY_OPTOUT_PATH, "{ruim")).status).toBe(401);
      expect((await send(on.base, RECOVERY_OPTOUT_PATH, "{ruim", "errada")).status).toBe(401);
      expect((await send(on.base, RECOVERY_OPTOUT_PATH, JSON.stringify({ x: "a".repeat(100_000) }))).status).toBe(401);
      expect((await send(on.base, RECOVERY_OPTOUT_PATH, "{ruim", "chave-r")).status).toBe(400);
      expect((await send(on.base, RECOVERY_OPTOUT_PATH, JSON.stringify({ x: "a".repeat(100_000) }), "chave-r")).status).toBe(400);
      expect((await send(on.base, RECOVERY_OPTOUT_PATH, "{}", "chave-r")).status).toBe(201);
      expect((await send(off.base, RECOVERY_OPTOUT_PATH, "{}", "chave-r")).status).toBe(404);
      expect((await send(noKey.base, RECOVERY_OPTOUT_PATH, "{}", "qualquer")).status).toBe(404);
      expect(await (await send(on.base, "/outra", JSON.stringify({ a: 1 }))).json()).toEqual({ got: { a: 1 } });
    } finally {
      for (const s of [on, off, noKey]) await new Promise(resolve => s.server.close(resolve));
    }
    const index = readFileSync(path.resolve(__dirname, "_core/index.ts"), "utf8");
    expect(index.indexOf("registerRecoveryOptOutGate(")).toBeGreaterThan(0);
    expect(index.indexOf("registerRecoveryOptOutGate(")).toBeLessThan(index.indexOf('app.use(express.json({ limit: "12mb" }))'));
    expect(index).toContain("registerRecoveryOptOutReceiver(app, ENV.recoveryIntegrationKey, ENV.recoveryEligibilityEnabled)");
  });
  it("a chave de integração do Recovery é própria e nasce vazia (rota 404) em env, exemplo e compose", () => {
    const root = path.resolve(__dirname, "..");
    expect(readFileSync(path.join(root, ".env.example"), "utf8")).toMatch(/^RECOVERY_INTEGRATION_KEY=\s/m);
    expect(readFileSync(path.join(root, "infra/pilot/docker-compose.yml"), "utf8")).toContain('RECOVERY_INTEGRATION_KEY: "${RECOVERY_INTEGRATION_KEY:-}"');
    expect(readFileSync(path.join(root, "server/_core/env.ts"), "utf8")).toContain('recoveryIntegrationKey: process.env.RECOVERY_INTEGRATION_KEY ?? ""');
  });
});
