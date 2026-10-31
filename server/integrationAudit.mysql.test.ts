import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { commercialFractionHistory, commercialFractionHolds, commercialFractions, commercialPolicyVersions, contracts, customers, domainEvents, installments, opportunities, proposals, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { registerSalesCommandBridge, type SalesCommandSale } from "./salesCommandBridge";

// Auditoria de integrações (T-C1, T-C2, T-C3) em MySQL descartável, dados SYN-. T-C4 (fora de ordem) já é coberto por saleValidation / relationshipCancellationReceiver / installmentSettlementOutbox.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const KEY = "SYN-audit-key";

type Reply = { status: number; body: Record<string, unknown> };

describe.skipIf(!integrationUrl)("auditoria de integrações em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let handler: (req: unknown, res: unknown) => Promise<void>;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 8 });
    db = drizzle({ client: pool });
    registerSalesCommandBridge({ post: (_path: string, fn: never) => { handler = fn; } } as never, KEY);
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  async function seedProject(label: string, fractionCount: number) {
    const name = `AUD ${label} ${runId}`;
    const externalKey = `aud-${label}-${runId}`;
    const [resort] = await db.insert(resorts).values({ name, externalKey }).$returningId();
    const [unit] = await db.insert(units).values({ resortId: resort.id, code: `U-AUD-${label}` }).$returningId();
    await db.insert(commercialPolicyVersions).values({ resortId: resort.id, policyType: "sale_terms", version: "aud-v1", policyJson: JSON.stringify({ usageModel: "fixed_week", balanceInstallmentCount: 3, balanceCadenceMonths: 1 }), effectiveAt: new Date("2026-01-01T00:00:00Z") });
    for (let sequence = 1; sequence <= fractionCount; sequence++) await db.insert(commercialFractions).values({ resortId: resort.id, unitId: unit.id, code: `F-AUD-${label}-${sequence}`, sequence, listPrice: "10000.00" });
    return { resortId: resort.id, project: { externalKey, name, timezone: "America/Sao_Paulo" } };
  }

  function saleEvent(project: SalesCommandSale["project"], customer: { name: string; phone?: string } = { name: `Casal AUD ${runId}`, phone: `+55119${Math.floor(Math.random() * 1e8)}` }): SalesCommandSale {
    return {
      eventId: `evt-${randomUUID()}`,
      eventName: "sale.ready_for_contract.v1",
      source: "sales-command",
      correlationId: `corr-${randomUUID()}`,
      occurredAt: "2026-10-04T15:30:00.000Z",
      project,
      saleId: `sale-${randomUUID()}`,
      encounterId: `enc-${randomUUID()}`,
      customer,
      sale: {
        quotasCount: 2, vgvCents: 1_000_001, entryContractedCents: 100_000, entryReceivedCents: 50_000, entryInstallmentCount: 3,
        entrySchedule: [{ sequence: 1, amountCents: 33_334, dueDate: "2026-10-04" }, { sequence: 2, amountCents: 33_333, dueDate: "2026-11-04" }, { sequence: 3, amountCents: 33_333, dueDate: "2026-12-04" }],
        firstBalanceDueInDays: 30, paymentMethods: ["pix"],
      },
    } as SalesCommandSale;
  }

  async function post(event: SalesCommandSale): Promise<Reply> {
    let status = 0; let body: Record<string, unknown> = {};
    const res = { headersSent: false, status(code: number) { status = code; return this; }, json(payload: Record<string, unknown>) { body = payload; return this; } };
    await handler({ get: () => `Bearer ${KEY}`, body: event }, res);
    return { status, body };
  }

  async function assertSingleFormalization(event: SalesCommandSale, resortId: number, quotas: number) {
    const rows = await db.select().from(contracts).where(eq(contracts.externalSaleId, event.saleId));
    expect(rows).toHaveLength(1);
    const contractId = rows[0]!.id;
    const fractions = await db.select().from(commercialFractions).where(eq(commercialFractions.currentContractId, contractId));
    expect(fractions).toHaveLength(quotas);
    expect(fractions.every(row => row.resortId === resortId)).toBe(true);
    const history = await db.select().from(commercialFractionHistory).where(and(eq(commercialFractionHistory.contractId, contractId), inArray(commercialFractionHistory.toStatus, ["sold", "held"])));
    expect(history).toHaveLength(quotas);
    expect(await db.select().from(installments).where(eq(installments.contractId, contractId))).toHaveLength(3 + 3);
    const created = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "contract.created.v2"), eq(domainEvents.aggregateId, String(contractId))));
    expect(created).toHaveLength(1);
    return { contractId, fractions };
  }

  // T-C1: mesmo sale.ready_for_contract.v1 (mesmo eventId) 100 vezes, em paralelo e em série. Pool de 8 conexões => disputa real de lock/deadlock; a ponte repete deadlock (withDeadlockRetry).
  for (const holdAtFormalization of [false, true]) {
    it(`T-C1 (${holdAtFormalization ? "reserva na formalização" : "venda direta"}): 100 reenvios em paralelo + 100 em série => 1 contrato, ${2} cotas, 1 evento; as demais respostas são replay`, async () => {
      if (holdAtFormalization) process.env.INVENTORY_HOLD_AT_FORMALIZATION = "true"; else delete process.env.INVENTORY_HOLD_AT_FORMALIZATION;
      try {
        const { resortId, project } = await seedProject(holdAtFormalization ? "c1-hold" : "c1", 5);
        const event = saleEvent(project);
        const burst = await Promise.all(Array.from({ length: 100 }, () => post(event)));
        const codes = burst.map(item => item.status);
        // Invariantes de dados primeiro (o que não pode falhar nunca): 1 contrato, 1 reserva por cota, 1 evento, no máximo uma criação.
        const { contractId, fractions } = await assertSingleFormalization(event, resortId, 2);
        expect(codes.filter(code => code === 201).length, "no máximo uma criação").toBeLessThanOrEqual(1);
        expect(burst.filter(item => item.status === 200).every(item => item.body.replay === true && item.body.contractId === contractId)).toBe(true);
        // Critério de resposta: nenhuma 5xx. Um deadlock transitório na sincronização da qualidade de receita (fora do retry) responde 503 (o Sales reenvia); isso aparece aqui como FAIL.
        expect(codes.filter(code => code >= 500), `respostas 5xx na rajada: ${codes.filter(code => code >= 500).length} de 100 (${JSON.stringify(burst.find(item => item.status >= 500))})`).toHaveLength(0);
        expect(codes.filter(code => code === 201)).toHaveLength(1);
        expect(codes.filter(code => code === 200)).toHaveLength(99);
        const serial: Reply[] = [];
        for (let index = 0; index < 100; index++) serial.push(await post(event));
        expect(serial.every(item => item.status === 200 && item.body.replay === true && item.body.contractId === contractId)).toBe(true);
        await assertSingleFormalization(event, resortId, 2);
        const holds = await db.select().from(commercialFractionHolds).where(inArray(commercialFractionHolds.fractionId, fractions.map(row => row.id)));
        if (holdAtFormalization) { expect(holds.filter(row => row.status === "active")).toHaveLength(2); expect(fractions.every(row => row.status === "held")).toBe(true); }
        else { expect(holds).toHaveLength(0); expect(fractions.every(row => row.status === "sold")).toBe(true); }
        const all = await db.select().from(commercialFractions).where(eq(commercialFractions.resortId, resortId));
        expect(all.filter(row => row.status === "available")).toHaveLength(3);
      } finally { delete process.env.INVENTORY_HOLD_AT_FORMALIZATION; }
    }, 120_000);
  }

  // T-C2: duas propostas (vendedores) disputam a MESMA cota ao mesmo tempo.
  it("T-C2: duas propostas disputando a mesma fração => só uma segura; a outra recebe CONFLICT; ao vencer o hold o estoque volta e a outra consegue", async () => {
    process.env.INVENTORY_NEGOTIATION_HOLDS = "true";
    try {
      const { inventoryRouter } = await import("./routers/inventory");
      const { sweepExpiredHolds } = await import("./holdSweep");
      const [sellerA] = await db.insert(users).values({ openId: `aud-a-${runId}`, name: "Vendedor A SYN", role: "seller" }).$returningId();
      const [sellerB] = await db.insert(users).values({ openId: `aud-b-${runId}`, name: "Vendedor B SYN", role: "seller" }).$returningId();
      const { resortId } = await seedProject("c2", 1);
      const [fraction] = await db.select().from(commercialFractions).where(eq(commercialFractions.resortId, resortId));
      const [customer] = await db.insert(customers).values({ fullName: `SYN C2 ${runId}`, status: "active" }).$returningId();
      const proposalFor = async (sellerId: number, tag: string) => {
        const [opportunity] = await db.insert(opportunities).values({ customerId: customer.id, title: `Opp C2 ${tag} ${runId}`, sellerId } as never).$returningId();
        return (await db.insert(proposals).values({ opportunityId: opportunity.id, reference: `P-C2-${tag}-${runId}`, productDescription: "Semana fixa", totalAmount: "5000.00", downPaymentAmount: "500.00", installmentCount: 3 }).$returningId())[0]!.id;
      };
      const [proposalA, proposalB] = [await proposalFor(sellerA.id, "A"), await proposalFor(sellerB.id, "B")];
      const as = (id: number) => inventoryRouter.createCaller({ user: { id, role: "seller" } } as never);
      const outcomes = await Promise.allSettled([as(sellerA.id).createHold({ fractionId: fraction.id, proposalId: proposalA }), as(sellerB.id).createHold({ fractionId: fraction.id, proposalId: proposalB })]);
      expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
      const loser = outcomes.find(item => item.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ code: "CONFLICT" });
      const winnerIsA = outcomes[0]!.status === "fulfilled";
      const active = (await db.select().from(commercialFractionHolds).where(eq(commercialFractionHolds.fractionId, fraction.id))).filter(row => row.status === "active");
      expect(active).toHaveLength(1);
      expect(active[0]!.proposalId).toBe(winnerIsA ? proposalA : proposalB);
      expect((await db.select().from(commercialFractions).where(eq(commercialFractions.id, fraction.id)))[0]).toMatchObject({ status: "held" });

      const past = new Date(Date.now() - 60 * 60_000);
      await db.update(commercialFractionHolds).set({ expiresAt: past }).where(eq(commercialFractionHolds.fractionId, fraction.id));
      await db.update(commercialFractions).set({ heldUntil: past }).where(eq(commercialFractions.id, fraction.id));
      await sweepExpiredHolds(db as never, { actorUserId: null, fractionIds: [fraction.id] });
      expect((await db.select().from(commercialFractions).where(eq(commercialFractions.id, fraction.id)))[0]).toMatchObject({ status: "available" });
      expect((await db.select().from(commercialFractionHolds).where(eq(commercialFractionHolds.fractionId, fraction.id))).filter(row => row.status === "active")).toHaveLength(0);

      // a proposta que perdeu agora consegue reservar
      const retry = await (winnerIsA ? as(sellerB.id).createHold({ fractionId: fraction.id, proposalId: proposalB }) : as(sellerA.id).createHold({ fractionId: fraction.id, proposalId: proposalA }));
      expect(retry.reused).toBe(false);
      expect((await db.select().from(commercialFractionHolds).where(eq(commercialFractionHolds.fractionId, fraction.id))).filter(row => row.status === "active")).toHaveLength(1);
    } finally { delete process.env.INVENTORY_NEGOTIATION_HOLDS; }
  }, 60_000);

  // T-C3: marcador único no nome/telefone; procura em TODAS as tabelas do banco e na saída de log.
  it("T-C3: venda sintética com marcador único no nome e no telefone => 0 ocorrências fora dos campos permitidos (cliente.nome/telefone) em eventos, auditoria, outbox, dead-letter e logs", async () => {
    const marker = `ZQ${runId.toUpperCase()}`;
    const phoneMarker = `7${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map(method => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); }));
    try {
      const { project } = await seedProject("c3", 3);
      const event = saleEvent(project, { name: `Fulano ${marker} Silva`, phone: `+5511${phoneMarker}` });
      const first = await post(event);
      expect(first.status).toBe(201);
      expect((await post(event)).status).toBe(200); // replay também não pode vazar
      await post({ ...event, customer: { name: "x" } } as never); // rejeição 400 também passa pelo log
    } finally { spies.forEach(spy => spy.mockRestore()); }

    const [tables] = await pool.query("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN ('varchar','text','mediumtext','longtext','char','json')") as unknown as [Array<{ t: string; c: string }>];
    const hits: Array<{ table: string; column: string; count: number; term: string }> = [];
    for (const term of [marker, phoneMarker]) {
      for (const { t, c } of tables) {
        const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE \`${c}\` LIKE ?`, [`%${term}%`]) as unknown as [Array<{ n: number }>];
        if (Number(rows[0]?.n) > 0) hits.push({ table: t, column: c, count: Number(rows[0]!.n), term });
      }
    }
    // Permitido: o cadastro do cliente e a ficha/oportunidade que o CRM é dono. Nenhuma outra tabela pode conter o dado pessoal.
    const allowed = new Set(["customers.fullName", "customers.phone"]);
    const leaks = hits.filter(hit => !allowed.has(`${hit.table}.${hit.column}`));
    expect(leaks, `dado pessoal fora dos campos permitidos: ${JSON.stringify(leaks)}`).toEqual([]);
    expect(hits.some(hit => hit.table === "customers" && hit.column === "fullName")).toBe(true); // controle: a varredura enxerga o dado onde ele deve estar
    expect(logs.filter(line => line.includes(marker) || line.includes(phoneMarker)), "marcador apareceu no log").toEqual([]);
  }, 120_000);
});
