import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureFichaV2, captureRecords, customerContacts, tasks, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Ficha do captador v2 (26/10) em MySQL real + a 0091 PROPOSTA aplicada no banco descartável do teste. Dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("ficha do captador v2 (MySQL real)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let sellerId: number;
  const previousEnv = { ...process.env };
  let seq = 0;

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    await pool.query("DROP TABLE IF EXISTS `capture_ficha_v2`");
    const sql = readFileSync(path.resolve(import.meta.dirname, "../migrations/proposed/PROPOSED_0091_capture_ficha_v2.sql"), "utf8");
    expect(sql.match(/FOREIGN KEY/g)).toHaveLength(1);
    for (const statement of sql.split("--> statement-breakpoint")) await pool.query(statement.replace(/^--.*$/gm, "").trim());
    sellerId = (await db.insert(users).values({ openId: `fichav2-${runId}`, name: "Vendedor SYN", role: "seller" }).$returningId())[0]!.id;
  });
  // A 0091 é só PROPOSTA: some do banco compartilhado do teste ao final, para não aparecer como FK fora do snapshot no teste de drift.
  afterAll(async () => { process.env = previousEnv; await pool?.query("DROP TABLE IF EXISTS `capture_ficha_v2`"); await pool?.end(); });

  const caller = () => appRouter.createCaller({ user: { id: sellerId, role: "seller" } } as never);
  const phone = () => `8497${String(++seq).padStart(3, "0")}${runId.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}`;
  const body = (extra: Record<string, unknown> = {}) => ({ customer: { fullName: `Casal SYN Ficha ${runId} ${seq + 1}`, phone: phone() }, salesRoom: "Sala 1", ...extra });
  const withFlag = async (fn: () => Promise<void>) => { process.env.CAPTURE_FICHA_V2_ENABLED = "true"; try { await fn(); } finally { delete process.env.CAPTURE_FICHA_V2_ENABLED; } };
  const extras = async (captureId: number) => (await db.select().from(captureFichaV2).where(eq(captureFichaV2.captureId, captureId)))[0];

  it("flag desligada (padrão): campo novo é recusado e nenhuma ficha nasce", async () => {
    delete process.env.CAPTURE_FICHA_V2_ENABLED;
    const b = body({ holderAge: 40 });
    await expect(caller().captures.create(b as never)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const rows = await db.select().from(users).where(eq(users.id, sellerId));
    expect(rows).toHaveLength(1);
    expect((await pool.query("SELECT COUNT(*) AS n FROM customers WHERE fullName = ?", [b.customer.fullName]) as any)[0][0].n).toBe(0);
  });

  it("flag desligada: ficha antiga (sem campo novo) segue igual e sem linha extra", async () => {
    const result = await caller().captures.create(body() as never);
    expect(await extras(result.captureId)).toBeUndefined();
  });

  it("tour direto: sem horário, sem tarefa de agendamento, aparece como captada, com idade do titular e 2º telefone", () => withFlag(async () => {
    const result = await caller().captures.create(body({ visitMode: "tour_direto", holderAge: 41, partnerAge: 38, partnerPhone: "(84) 99999-1111", vehicleModel: "Onix 2019" }) as never);
    const row = (await db.select().from(captureRecords).where(eq(captureRecords.id, result.captureId)))[0]!;
    expect(row).toMatchObject({ scheduledAt: null, presentationStatus: "captured", isPasserby: false, partnerAge: 38, vehicleBrand: null, vehicleModel: "Onix 2019" });
    expect(result.taskId).toBeNull();
    expect(await extras(result.captureId)).toMatchObject({ visitMode: "tour_direto", holderAge: 41 });
    const contacts = await db.select().from(customerContacts).where(eq(customerContacts.customerId, result.customerId));
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ kind: "phone", value: "(84) 99999-1111", label: "Telefone do cônjuge", isPreferred: false });
  }));

  it("agendamento: data e horário viram scheduledAt e tarefa; sem data é recusado", () => withFlag(async () => {
    await expect(caller().captures.create(body({ visitMode: "agendamento" }) as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const result = await caller().captures.create(body({ visitMode: "agendamento", scheduledAt: "2026-12-01T15:30:00.000Z", holderAge: 50 }) as never);
    const row = (await db.select().from(captureRecords).where(eq(captureRecords.id, result.captureId)))[0]!;
    expect(row.presentationStatus).toBe("scheduled");
    expect(result.taskId).not.toBeNull();
    expect((await db.select().from(tasks).where(eq(tasks.id, result.taskId!)))).toHaveLength(1);
    expect(await extras(result.captureId)).toMatchObject({ visitMode: "agendamento", holderAge: 50 });
  }));

  it("tour direto com horário, ou também passante, é recusado; idade fora de 0–120 é recusada", () => withFlag(async () => {
    await expect(caller().captures.create(body({ visitMode: "tour_direto", scheduledAt: "2026-12-01T15:30:00.000Z" }) as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().captures.create(body({ visitMode: "tour_direto", isPasserby: true }) as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().captures.create(body({ holderAge: 130 }) as never)).rejects.toBeTruthy();
  }));

  it("regra da visita ligada: tour direto passa; ficha sem data e sem modo continua recusada", () => withFlag(async () => {
    process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY = "true";
    try {
      await expect(caller().captures.create(body() as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const result = await caller().captures.create(body({ visitMode: "tour_direto" }) as never);
      expect(result.captureId).toBeGreaterThan(0);
    } finally { delete process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY; }
  }));

  it("2º telefone igual ao principal ou repetido não duplica contato; reenvio com o mesmo clientRequestId devolve a mesma ficha", () => withFlag(async () => {
    const same = phone();
    const first = await caller().captures.create({ customer: { fullName: `Casal SYN Dup ${runId}`, phone: same }, salesRoom: "Sala 1", visitMode: "tour_direto", partnerPhone: same, clientRequestId: randomUUID() } as never);
    expect(await db.select().from(customerContacts).where(eq(customerContacts.customerId, first.customerId))).toHaveLength(0);
    const key = randomUUID();
    const b = { customer: { fullName: `Casal SYN Replay ${runId}`, phone: phone() }, salesRoom: "Sala 1", visitMode: "tour_direto", partnerPhone: "84988887777", clientRequestId: key };
    const a1 = await caller().captures.create(b as never);
    const a2 = await caller().captures.create(b as never);
    expect(a2.captureId).toBe(a1.captureId);
    expect(await db.select().from(customerContacts).where(eq(customerContacts.customerId, a1.customerId))).toHaveLength(1);
    expect(await db.select().from(captureFichaV2).where(eq(captureFichaV2.captureId, a1.captureId))).toHaveLength(1);
  }));
});
