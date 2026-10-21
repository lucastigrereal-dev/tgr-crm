import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureErasureRequests, captureRecords, contracts, customers, opportunities, proposals } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { evaluateCaptureEligibility, loadEligibilityFacts } from "./nonBuyerEligibility";

// C2/C3 fatia 1: o carregador de fatos lê o banco real (contratos, propostas via opportunities.customerId, oportunidades, exclusão, anonimização) e o predicado decide. Só leitura.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("elegibilidade de não-comprador em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let seq = 0;
  const previousEnv = { ...process.env };
  const closedAt = new Date("2026-10-21T15:00:00Z");

  /** Cliente + ficha encerrada (ramo A), sem venda: base elegível. */
  const couple = async (patch: Record<string, unknown> = {}) => {
    const n = ++seq;
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal NB ${n} ${runId}`, documentNumber: `CPF-NB-${n}-${runId}`, phone: `1199999${String(n).padStart(4, "0")}`, status: "active" }).$returningId();
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId, salesRoom: `Sala NB ${runId}`, coupleCode: `NB-${n}-${runId}`, presentationStatus: "closed", presentationEndedAt: closedAt, ...patch } as never).$returningId();
    const [{ id: oppId }] = await db.insert(opportunities).values({ customerId, title: `Op NB ${n}`, stage: "qualified" } as never).$returningId();
    return { customerId, captureId, oppId, n };
  };
  const decide = async (captureId: number) => (await evaluateCaptureEligibility(db, captureId))!;

  beforeAll(() => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
  });
  afterAll(async () => { await pool?.end(); });

  it("ficha captada com oportunidade qualified e atendimento encerrado sem venda É elegível; ficha inexistente devolve null", async () => {
    const { captureId } = await couple();
    expect(await decide(captureId)).toMatchObject({ eligible: true, branch: "closed" });
    expect(await evaluateCaptureEligibility(db, 2_000_000_000)).toBeNull();
  });

  it("atendimento em andamento (presented) não é elegível; não-tour com tipo e motivo é elegível pelo ramo B", async () => {
    const running = await couple({ presentationStatus: "presented", presentationEndedAt: null });
    expect((await decide(running.captureId)).reasons).toEqual(["attendance_not_finished"]);
    const nt = await couple({ presentationStatus: "no_tour", presentationEndedAt: null, ntKind: "perfil", ntMotiveId: 3 });
    expect(await decide(nt.captureId)).toMatchObject({ eligible: true, branch: "no_tour" });
  });

  it("contrato do cliente bloqueia em todo status menos cancelled (closed bloqueia); distrato volta a ser elegível", async () => {
    for (const status of ["draft", "pending_signature", "active", "overdue", "closed"] as const) {
      const c = await couple();
      await db.insert(contracts).values({ number: `NB-${status}-${c.n}-${runId}`, customerId: c.customerId, usageModel: "fixed_week", status, totalAmount: "1000.00" } as never);
      expect((await decide(c.captureId)).reasons, status).toEqual(["sale_in_progress"]);
    }
    const c = await couple();
    const [{ id }] = await db.insert(contracts).values({ number: `NB-cancel-${c.n}-${runId}`, customerId: c.customerId, usageModel: "fixed_week", status: "active", totalAmount: "1000.00" } as never).$returningId();
    expect((await decide(c.captureId)).eligible).toBe(false);
    await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, id));
    expect((await decide(c.captureId)).eligible).toBe(true);
  });

  it("proposta (ligada ao cliente por opportunities.customerId) draft/sent/approved bloqueia; rejected/expired não", async () => {
    for (const [status, blocks] of [["draft", true], ["sent", true], ["approved", true], ["rejected", false], ["expired", false]] as const) {
      const c = await couple();
      await db.insert(proposals).values({ opportunityId: c.oppId, reference: `P-NB-${status}-${c.n}-${runId}`, productDescription: "Semana", totalAmount: "10000.00", downPaymentAmount: "1000.00", installmentCount: 3, status });
      expect((await decide(c.captureId)).eligible, status).toBe(!blocks);
    }
  });

  it("oportunidade proposal/negotiation/won bloqueia; lost/new/qualified não; VENDEU bloqueia", async () => {
    for (const [stage, blocks] of [["new", false], ["lost", false], ["proposal", true], ["negotiation", true], ["won", true]] as const) {
      const c = await couple();
      await db.update(opportunities).set({ stage }).where(eq(opportunities.id, c.oppId));
      expect((await decide(c.captureId)).eligible, stage).toBe(!blocks);
    }
    const sold = await couple({ commercialOutcome: "vendeu" });
    expect((await decide(sold.captureId)).reasons).toEqual(["sale_in_progress"]);
    const fell = await couple({ commercialOutcome: "caiu_em_mesa" });
    expect((await decide(fell.captureId)).eligible).toBe(true);
  });

  it("anonimizado (ficha ou cliente) e exclusão pendente tiram; exclusão cumprida/recusada não conta como pendente", async () => {
    const a = await couple({ anonymizedAt: closedAt });
    expect((await decide(a.captureId)).reasons).toEqual(["anonymized"]);
    const b = await couple();
    await db.update(customers).set({ anonymizedAt: closedAt }).where(eq(customers.id, b.customerId));
    expect((await decide(b.captureId)).reasons).toEqual(["anonymized"]);
    const c = await couple();
    const [{ id }] = await db.insert(captureErasureRequests).values({ captureId: c.captureId, customerId: c.customerId, coupleCode: `NB-${c.n}-${runId}`, reason: "pedido do titular", status: "requested" }).$returningId();
    expect((await decide(c.captureId)).reasons).toEqual(["erasure"]);
    await db.update(captureErasureRequests).set({ status: "rejected" }).where(eq(captureErasureRequests.id, id));
    expect((await decide(c.captureId)).eligible).toBe(true);
  });

  it("somente leitura: avaliar não altera ficha, contratos nem oportunidades", async () => {
    const c = await couple();
    const snapshot = async () => JSON.stringify([await db.select().from(captureRecords).where(eq(captureRecords.id, c.captureId)), await db.select().from(opportunities).where(eq(opportunities.customerId, c.customerId))]);
    const before = await snapshot();
    await loadEligibilityFacts(db, c.captureId);
    await decide(c.captureId);
    expect(await snapshot()).toBe(before);
  });
});
