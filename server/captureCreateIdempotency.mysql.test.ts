import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// M-A15-02 em MySQL real: ficha criada no celular sem sinal e reenviada (resposta perdida, 2 abas, sync repetido) vira UMA ficha só. Dados 100% sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("criação idempotente da ficha (fila offline) em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let sellerId: number;
  const previousEnv = { ...process.env };
  let phoneSeq = 0;

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 6 });
    db = drizzle({ client: pool });
    [{ id: sellerId }] = await db.insert(users).values({ openId: `capidem-${runId}`, name: "Captador sintético", role: "seller" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const caller = () => appRouter.createCaller({ user: { id: sellerId, role: "seller" } } as never);
  const payload = (label: string, extra: Record<string, unknown> = {}) => ({ customer: { fullName: `Casal Offline ${label} ${runId}`, phone: `8497${String(++phoneSeq).padStart(3, "0")}${runId.replace(/\D/g, "").padEnd(4, "0").slice(0, 4)}` }, salesRoom: `Sala OFF ${runId}`, ...extra });
  const capturesOf = async (customerId: number) => db.select({ id: captureRecords.id }).from(captureRecords).where(eq(captureRecords.customerId, customerId));

  it("reenvio com o MESMO clientRequestId devolve a mesma ficha e não cria outra", async () => {
    const clientRequestId = randomUUID();
    const first = await caller().captures.create({ ...payload("reenvio"), clientRequestId } as never);
    const again = await caller().captures.create({ ...payload("reenvio"), clientRequestId } as never);
    expect(again).toEqual({ ...first, replayed: true });
    expect(await capturesOf(first.customerId)).toHaveLength(1);
    const keyed = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `capture-create:${clientRequestId}`));
    expect(keyed).toHaveLength(1);
    expect(keyed[0]).toMatchObject({ entityId: String(first.captureId), action: "create_idempotency" });
  });

  it("duas tentativas SIMULTÂNEAS (sinal voltou em duas abas) gravam UMA ficha", async () => {
    const clientRequestId = randomUUID();
    const body = { ...payload("corrida"), clientRequestId };
    const results = await Promise.allSettled([caller().captures.create(body as never), caller().captures.create(body as never), caller().captures.create(body as never)]);
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<ReturnType<typeof caller>["captures"]["create"]>>> => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map(r => r.value.captureId)).size).toBe(1);
    expect(await capturesOf(ok[0]!.value.customerId)).toHaveLength(1);
  });

  it("ids diferentes são fichas diferentes; sem clientRequestId o comportamento antigo segue (cada envio cria ficha)", async () => {
    const a = await caller().captures.create({ ...payload("a"), clientRequestId: randomUUID() } as never);
    const b = await caller().captures.create({ ...payload("b"), clientRequestId: randomUUID() } as never);
    expect(a.captureId).not.toBe(b.captureId);
    const legacy = payload("legado");
    const one = await caller().captures.create(legacy as never);
    const two = await caller().captures.create(legacy as never);
    expect(two.captureId).not.toBe(one.captureId);
  });

  it("falha na criação NÃO deixa a trava: a mesma chave pode ser reenviada depois de corrigir a ficha", async () => {
    const clientRequestId = randomUUID();
    await expect(caller().captures.create({ ...payload("falha", { resortId: 2_000_000_000 }), clientRequestId } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `capture-create:${clientRequestId}`))).toHaveLength(0);
    const fixed = await caller().captures.create({ ...payload("falha"), clientRequestId } as never);
    expect(fixed.captureId).toBeGreaterThan(0);
  });

  it("o replay é do DONO: outro usuário com o mesmo UUID recebe CONFLICT e não vê os ids da ficha alheia", async () => {
    const clientRequestId = randomUUID();
    await caller().captures.create({ ...payload("dono"), clientRequestId } as never);
    const [{ id: otherId }] = await db.insert(users).values({ openId: `capidem2-${runId}`, name: "Outro captador", role: "seller" }).$returningId();
    const other = appRouter.createCaller({ user: { id: otherId, role: "seller" } } as never);
    await expect(other.captures.create({ ...payload("dono"), clientRequestId } as never)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("clientRequestId que não é UUID é recusado (nada de chave livre)", async () => {
    await expect(caller().captures.create({ ...payload("lixo"), clientRequestId: "x'; DROP TABLE" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
