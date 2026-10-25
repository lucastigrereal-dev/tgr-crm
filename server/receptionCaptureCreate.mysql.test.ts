import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, opportunities, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Decisão 25/10 (2B): a recepção (service) também cadastra casal sem ficha, só com a flag ligada, e só REGISTRA o casal (sem captador, campanha, qualificação nem oportunidade). Dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("recepção cadastra casal sem ficha (MySQL real)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let ids: Record<"admin" | "seller" | "service", number>;
  const previousEnv = { ...process.env };
  let seq = 0;

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    const make = async (role: "admin" | "seller" | "service") => (await db.insert(users).values({ openId: `recep-${role}-${runId}`, name: `Sintético ${role}`, role }).$returningId())[0]!.id;
    ids = { admin: await make("admin"), seller: await make("seller"), service: await make("service") };
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const as = (role: "admin" | "seller" | "service") => appRouter.createCaller({ user: { id: ids[role], role } } as never);
  const body = (extra: Record<string, unknown> = {}) => ({ customer: { fullName: `Casal Recepção ${runId} ${++seq}`, phone: `8498${String(seq).padStart(3, "0")}${runId.replace(/\D/g, "").padEnd(4, "7").slice(0, 4)}` }, salesRoom: "Sala 1", isPasserby: true, ...extra });
  const capture = async (id: number) => (await db.select().from(captureRecords).where(eq(captureRecords.id, id)))[0]!;

  it("flag desligada (padrão): recepção continua FORBIDDEN", async () => {
    delete process.env.RECEPTION_CAPTURE_CREATE_ENABLED;
    await expect(as("service").captures.create(body() as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  describe("flag ligada", () => {
    const withFlag = async (fn: () => Promise<void>) => { process.env.RECEPTION_CAPTURE_CREATE_ENABLED = "true"; try { await fn(); } finally { delete process.env.RECEPTION_CAPTURE_CREATE_ENABLED; } };

    it("corpo mínimo: cria a ficha, sem oportunidade, sem captador e com qualificação pendente", () => withFlag(async () => {
      const result = await as("service").captures.create(body() as never);
      expect(result.opportunityId).toBeNull();
      const row = await capture(result.captureId);
      expect(row).toMatchObject({ promoterId: null, qualifierId: null, campaignId: null, qualificationStatus: "pending", opportunityId: null });
      expect(await db.select().from(opportunities).where(eq(opportunities.customerId, result.customerId))).toHaveLength(0);
    }));

    it("liner, closer, gerente de sala e os demais dados do casal continuam permitidos", () => withFlag(async () => {
      const result = await as("service").captures.create(body({ linerId: ids.seller, closerId: ids.admin, roomManagerId: ids.admin, transportation: "Carro", captureLocation: "Orla" }) as never);
      expect(await capture(result.captureId)).toMatchObject({ linerId: ids.seller, closerId: ids.admin, roomManagerId: ids.admin });
    }));

    const forbidden: Array<[string, Record<string, unknown>]> = [
      ["captador (promoterId)", { promoterId: 0 }],
      ["qualificador (qualifierId)", { qualifierId: 0 }],
      ["campanha (campaignId)", { campaignId: 0 }],
      ["qualificação diferente de pendente", { qualificationStatus: "qualified" }],
      ["abrir oportunidade (createOpportunity=true)", { createOpportunity: true }],
    ];
    it.each(forbidden)("recepção com %s é FORBIDDEN pela regra (corpo válido)", (_label, extra) => withFlag(async () => {
      // ids positivos reais: o corpo passa no zod, então a recusa vem da regra e não da validação.
      const value = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v === 0 ? ids.seller : v]));
      await expect(as("service").captures.create(body(value) as never)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("A recepção só registra o casal") });
    }));

    it("admin e vendedor seguem atribuindo captador, campanha, qualificação e oportunidade", () => withFlag(async () => {
      for (const role of ["admin", "seller"] as const) {
        const result = await as(role).captures.create(body({ promoterId: ids.seller, qualificationStatus: "qualified", createOpportunity: true }) as never);
        expect(result.opportunityId).not.toBeNull();
        expect(await capture(result.captureId)).toMatchObject({ promoterId: ids.seller, qualificationStatus: "qualified" });
      }
    }));

    it("sem createOpportunity informado a sala continua abrindo oportunidade (comportamento de antes)", () => withFlag(async () => {
      const result = await as("seller").captures.create(body() as never);
      expect(result.opportunityId).not.toBeNull();
    }));
  });
});
