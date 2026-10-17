import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Endpoint de leitura do NQ em MySQL real: desligado = 404 para todos; ligado = só o cálculo, sem CPF, telefone nem renda.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = `chave-nq-${runId}`;

describe.skipIf(!integrationUrl)("endpoint de leitura do NQ em MySQL real", () => {
  let pool: mysql.Pool;
  let on: Server, off: Server;
  let onUrl: string, offUrl: string;
  const previousEnv = { ...process.env };
  const coupleCode = `TGR-NQ-${runId}`;
  const listen = async (app: express.Express) => { const server = createServer(app); await new Promise<void>(resolve => server.listen(0, resolve)); return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }; };
  const get = (base: string, code: string, key: string | null = KEY) => fetch(`${base}/api/integrations/sales-command/nq/${encodeURIComponent(code)}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    const { registerNqReadEndpoint } = await import("./nqReadEndpoint");
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    const db = drizzle({ client: pool });
    const [{ id: userId }] = await db.insert(users).values({ openId: `nq-user-${runId}`, name: "Gerente", role: "admin" }).$returningId();
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal NQ ${runId}`, documentNumber: `98765432100`, phone: "11977776666", birthDate: new Date("1980-01-01"), status: "active" } as never).$returningId();
    await db.insert(captureRecords).values({ customerId, promoterId: userId, salesRoom: `Sala NQ ${runId}`, coupleCode, maleSpouse: "titular", relationshipStatus: "Casado", relationshipYears: 5, relationshipMonths: 0, vehicleKind: "carro", vehicleYear: 2022, averageIncome: "23456.78", hasCreditCard: true, ownsHome: false } as never);
    const appOn = express(); registerNqReadEndpoint(appOn, KEY, true);
    const appOff = express(); registerNqReadEndpoint(appOff, KEY, false);
    ({ server: on, url: onUrl } = await listen(appOn));
    ({ server: off, url: offUrl } = await listen(appOff));
  });
  afterAll(async () => { process.env = previousEnv; await Promise.all([on, off].map(server => new Promise(resolve => server?.close(resolve)))); await pool?.end(); });

  it("desligado: 404 mesmo com a chave certa", async () => {
    expect((await get(offUrl, coupleCode)).status).toBe(404);
    expect((await get(offUrl, coupleCode, null)).status).toBe(404);
  });

  it("ligado: 401 sem chave certa, 404 para código inválido ou desconhecido", async () => {
    expect((await get(onUrl, coupleCode, null)).status).toBe(401);
    expect((await get(onUrl, coupleCode, "errada")).status).toBe(401);
    expect((await get(onUrl, `NAO-EXISTE-${runId}`)).status).toBe(404);
    expect((await get(onUrl, "x")).status).toBe(404);
  });

  it("ligado: devolve só o cálculo do NQ, sem CPF, telefone, nome nem renda", async () => {
    const response = await get(onUrl, coupleCode.toLowerCase());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["coupleCode", "nq"]);
    expect(body.coupleCode).toBe(coupleCode);
    expect(body.nq).toMatchObject({ nqItems: 1, outcome: "nq_aceito" });
    expect(body.nq.criteria.find((c: { key: string }) => c.key === "casa_propria")).toMatchObject({ status: "nq" });
    expect(body.nq.criteria.find((c: { key: string }) => c.key === "renda")).toEqual({ key: "renda", status: "ok", detail: "Renda dentro do mínimo." });
    const text = JSON.stringify(body);
    for (const secret of ["98765432100", "11977776666", `Casal NQ ${runId}`, "23456", "23.456"]) expect(text).not.toContain(secret);
  });
});
