import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureMotives, captureRecords, customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Motivos padronizados e NT de perfil/tempo/consultor em MySQL real: lista provisória semeada, motivo obrigatório, imutável, captador gravado.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("motivos padronizados e não tour em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let adminId: number;
  let promoterId: number;
  let customerId: number;
  const previousEnv = { ...process.env };
  const caller = (role = "admin") => appRouter.createCaller({ user: { id: adminId, role } } as never);
  const newCapture = async (extra: Partial<typeof captureRecords.$inferInsert> = {}) => {
    const [{ id }] = await db.insert(captureRecords).values({ customerId, promoterId, salesRoom: `Sala ${runId}`, checkedInAt: new Date(), ...extra }).$returningId();
    return id;
  };
  const motiveOf = async (kind: "nt_perfil" | "nt_tempo" | "nt_consultor" | "nt_mesa", code: string) => (await db.select().from(captureMotives).where(eq(captureMotives.kind, kind)).then(rows => rows.find(row => row.code === code)))!;

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: adminId }] = await db.insert(users).values({ openId: `mot-admin-${runId}`, name: "Gerente", role: "admin" }).$returningId();
    [{ id: promoterId }] = await db.insert(users).values({ openId: `mot-prom-${runId}`, name: `Captador ${runId}`, role: "seller" }).$returningId();
    [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Motivo ${runId}`, documentNumber: `CPF-M-${runId}`, phone: "11999990001", status: "active" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  it("a lista provisória vem semeada para os quatro NT e a qualificação", async () => {
    const all = await caller().captureSheet.motives.list();
    for (const kind of ["nt_perfil", "nt_tempo", "nt_consultor", "nt_mesa", "qualificacao"]) expect(all.some(motive => motive.kind === kind)).toBe(true);
    expect(all.find(motive => motive.kind === "nt_perfil" && motive.code === "outro")?.requiresComplement).toBe(true);
  });

  it("NT de perfil grava motivo, captador e vira no_tour; repetir igual é idempotente; mudar é recusado", async () => {
    const captureId = await newCapture();
    const motive = await motiveOf("nt_perfil", "renda");
    await expect(caller("seller").captureSheet.recordNt({ captureId, kind: "perfil", motiveId: motive.id })).resolves.toMatchObject({ ok: true, alreadyRecorded: false });
    const [row] = await db.select().from(captureRecords).where(eq(captureRecords.id, captureId));
    expect(row).toMatchObject({ ntKind: "perfil", ntMotiveId: motive.id, ntCaptorName: `Captador ${runId}`, presentationStatus: "no_tour", noTourReason: "Renda abaixo do mínimo" });
    expect(row.presentationEndedAt).toBeInstanceOf(Date);
    await expect(caller().captureSheet.recordNt({ captureId, kind: "perfil", motiveId: motive.id })).resolves.toMatchObject({ alreadyRecorded: true });
    const other = await motiveOf("nt_perfil", "idade");
    await expect(caller().captureSheet.recordNt({ captureId, kind: "perfil", motiveId: other.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("motivo de outro tipo, motivo 'outro' sem complemento e papel sem permissão são recusados", async () => {
    const captureId = await newCapture();
    const tempo = await motiveOf("nt_tempo", "sem_tempo");
    await expect(caller().captureSheet.recordNt({ captureId, kind: "perfil", motiveId: tempo.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const outro = await motiveOf("nt_perfil", "outro");
    await expect(caller().captureSheet.recordNt({ captureId, kind: "perfil", motiveId: outro.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().captureSheet.recordNt({ captureId, kind: "perfil", motiveId: outro.id, complement: "Casal já é cliente" })).resolves.toMatchObject({ ok: true });
    const fresh = await newCapture();
    await expect(caller("service").captureSheet.recordNt({ captureId: fresh, kind: "tempo", motiveId: tempo.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ficha que já apresentou ou já tem resultado comercial não vira NT", async () => {
    const tempo = await motiveOf("nt_tempo", "sem_tempo");
    const presented = await newCapture({ presentationStatus: "presented" });
    await expect(caller().captureSheet.recordNt({ captureId: presented, kind: "tempo", motiveId: tempo.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const alreadyNt = await newCapture({ presentationStatus: "no_tour", noTourReason: "motivo antigo" });
    await expect(caller().captureSheet.recordNt({ captureId: alreadyNt, kind: "tempo", motiveId: tempo.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const sold = await newCapture({ commercialOutcome: "vendeu" });
    await expect(caller().captureSheet.recordNt({ captureId: sold, kind: "tempo", motiveId: tempo.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("CAIU EM MESA com motivo da lista grava o texto e o id do motivo", async () => {
    const captureId = await newCapture({ presentationStatus: "presented", closerId: adminId });
    const motive = await motiveOf("nt_mesa", "preco");
    await caller().captures.recordCommercialOutcome({ id: captureId, outcome: "caiu_em_mesa", motiveId: motive.id, reason: "achou caro o plano 3" });
    const [row] = await db.select().from(captureRecords).where(eq(captureRecords.id, captureId));
    expect(row).toMatchObject({ commercialOutcome: "caiu_em_mesa", commercialOutcomeMotiveId: motive.id, commercialOutcomeReason: "Valor acima do que o casal quer pagar: achou caro o plano 3" });
    // Repetir a mesma chamada continua idempotente mesmo se o motivo for desativado depois.
    await caller().captureSheet.motives.upsert({ id: motive.id, kind: "nt_mesa", code: "preco", label: motive.label, active: false });
    await expect(caller().captures.recordCommercialOutcome({ id: captureId, outcome: "caiu_em_mesa", motiveId: motive.id, reason: "achou caro o plano 3" })).resolves.toMatchObject({ alreadyRecorded: true });
    await caller().captureSheet.motives.upsert({ id: motive.id, kind: "nt_mesa", code: "preco", label: motive.label, active: true });
    const wrongKind = await motiveOf("nt_perfil", "renda");
    const second = await newCapture({ presentationStatus: "presented", closerId: adminId });
    await expect(caller().captures.recordCommercialOutcome({ id: second, outcome: "caiu_em_mesa", motiveId: wrongKind.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("só a administração cria e desativa motivo; tipo e código não mudam; motivo desativado some da lista da sala", async () => {
    await expect(caller("seller").captureSheet.motives.upsert({ kind: "nt_tempo", code: `x_${runId}`, label: "Teste" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller().captureSheet.motives.upsert({ kind: "nt_tempo", code: `x_${runId}`, label: "Motivo de teste" });
    const created = (await caller().captureSheet.motives.list({ kind: "nt_tempo" })).find(motive => motive.code === `x_${runId}`)!;
    await expect(caller().captureSheet.motives.upsert({ id: created.id, kind: "nt_perfil", code: created.code, label: "Motivo de teste" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller().captureSheet.motives.upsert({ id: created.id, kind: "nt_tempo", code: created.code, label: "Motivo de teste", active: false });
    expect((await caller("seller").captureSheet.motives.list({ kind: "nt_tempo", includeInactive: true })).some(motive => motive.id === created.id)).toBe(false);
    expect((await caller().captureSheet.motives.list({ kind: "nt_tempo", includeInactive: true })).some(motive => motive.id === created.id)).toBe(true);
    await expect(caller().captureSheet.motives.upsert({ kind: "nt_tempo", code: `x_${runId}`, label: "Duplicado" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
