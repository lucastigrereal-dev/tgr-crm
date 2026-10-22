import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { commercialFractionHistory, commercialFractionHolds, commercialFractions, contractCancellationRequests, commercialPolicyVersions, contracts, customers, domainEvents, resorts, tasks, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { materializeSalesCommandSale, registerSalesCommandBridge, type SalesCommandSale } from "./salesCommandBridge";
import { sweepExpiredHolds } from "./holdSweep";
import { withDeadlockRetry } from "./mysqlErrors";

// CRM-E1 em MySQL real: cota reservada até as duas conferências; vencida => volta ao estoque, tarefa, 422 no replay. Dados SYN-.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("E1: reserva da cota na formalização", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let adminId = 0, customerId = 0, resortId = 0, unitId = 0, seq = 0;
  const previousEnv = { ...process.env };
  const contractsApi = async () => (await import("./routers/contracts")).contractsRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
  const saleApi = async () => (await import("./routers/saleValidation")).saleValidationRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 8 });
    db = drizzle({ client: pool });
    adminId = (await db.insert(users).values({ openId: `e1-admin-${runId}`, name: "SYN admin", role: "admin" }).$returningId())[0]!.id;
    customerId = (await db.insert(customers).values({ fullName: `SYN E1 ${runId}`, status: "active" }).$returningId())[0]!.id;
    resortId = (await db.insert(resorts).values({ name: `SYN E1 ${runId}`, externalKey: `e1-${runId}`, status: "active" }).$returningId())[0]!.id;
    unitId = (await db.insert(units).values({ resortId, code: `U-E1-${runId}` }).$returningId())[0]!.id;
    await db.insert(commercialPolicyVersions).values({ resortId, policyType: "sale_terms", version: "e1-v1", policyJson: JSON.stringify({ usageModel: "fixed_week", balanceInstallmentCount: 3, balanceCadenceMonths: 1 }), effectiveAt: new Date("2026-01-01T00:00:00Z") });
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const newFraction = async () => { seq += 1; return (await db.insert(commercialFractions).values({ resortId, unitId, code: `F-E1-${seq}-${runId}`, sequence: seq, listPrice: "1000.00" }).$returningId())[0]!.id; };
  const fraction = async (id: number) => (await db.select().from(commercialFractions).where(eq(commercialFractions.id, id)))[0]!;
  const holds = (fractionId: number) => db.select().from(commercialFractionHolds).where(eq(commercialFractionHolds.fractionId, fractionId));
  const contractRow = async (id: number) => (await db.select().from(contracts).where(eq(contracts.id, id)))[0]!;
  const createContract = async (label: string, fractionId: number) => (await (await contractsApi()).create({ number: `E1-${label}-${runId}`, customerId, fractionId, usageModel: "fixed_week", status: "pending_signature", totalAmount: 1000, firstDueDate: "2027-01-10", installmentCount: 2 })).id;
  const lostEvents = (id: number) => db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "contract.inventory_lost"), eq(domainEvents.aggregateId, String(id))));
  const expireHolds = async (fractionId: number) => db.update(commercialFractionHolds).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(commercialFractionHolds.fractionId, fractionId));

  it("desligado por padrão: contrato vende a cota na criação", async () => {
    delete process.env.INVENTORY_HOLD_AT_FORMALIZATION;
    const f = await newFraction(); await createContract("off", f);
    expect((await fraction(f)).status).toBe("sold");
  });

  describe("ligado", () => {
    beforeAll(() => { process.env.INVENTORY_HOLD_AT_FORMALIZATION = "true"; });
    afterAll(() => { delete process.env.INVENTORY_HOLD_AT_FORMALIZATION; });

    it("contrato reserva a cota (held) com hold de formalização de 48 h; só as duas conferências a vendem", async () => {
      const f = await newFraction(); const id = await createContract("ok", f);
      const held = await fraction(f);
      expect(held).toMatchObject({ status: "held", currentContractId: id });
      const [hold] = await holds(f);
      expect(hold).toMatchObject({ purpose: "formalization", contractId: id, status: "active" });
      const hours = (hold!.expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(47.9); expect(hours).toBeLessThan(48.1);
      const api = await saleApi();
      await api.confirmPayment({ contractId: id, note: "comprovante conferido" });
      expect((await fraction(f)).status).toBe("held");
      await api.confirmDocuments({ contractId: id, note: "documentação conferida" });
      expect((await fraction(f)).status).toBe("sold");
      expect((await holds(f))[0]!.status).toBe("consumed");
    });

    it("política stock_hold versionada define o prazo; valor inválido é recusado", async () => {
      const policies = (await import("./routers/commercialPolicies")).commercialPoliciesRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
      await expect(policies.create({ resortId, policyType: "stock_hold", version: "bad", policy: { ttlHours: 0 } } as never)).rejects.toThrow();
      await policies.create({ resortId, policyType: "stock_hold", version: "e1-2h", policy: { ttlHours: 2 }, effectiveAt: new Date(Date.now() - 30_000) } as never);
      const f = await newFraction(); await createContract("ttl", f);
      const hours = ((await holds(f))[0]!.expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(1.9); expect(hours).toBeLessThan(2.1);
      await db.update(commercialPolicyVersions).set({ retiredAt: new Date() }).where(and(eq(commercialPolicyVersions.resortId, resortId), eq(commercialPolicyVersions.policyType, "stock_hold")));
    });

    it("dois contratos na mesma cota: o segundo é recusado e a reserva do primeiro continua", async () => {
      const f = await newFraction(); const first = await createContract("race-a", f);
      const outcomes = await Promise.allSettled([createContract("race-b", f), createContract("race-c", f)]);
      expect(outcomes.every(item => item.status === "rejected")).toBe(true);
      expect((await fraction(f))).toMatchObject({ status: "held", currentContractId: first });
      expect((await holds(f)).filter(item => item.status === "active")).toHaveLength(1);
    });

    it("hold vencido na segunda conferência: cota volta ao estoque, tarefa ao administrativo, INVENTORY_HELD_EXPIRED, validação recusada", async () => {
      const f = await newFraction(); const id = await createContract("late", f);
      const api = await saleApi();
      await api.confirmPayment({ contractId: id, note: "comprovante conferido" });
      await expireHolds(f);
      await expect(api.confirmDocuments({ contractId: id, note: "documentação conferida" })).rejects.toThrow(/INVENTORY_HELD_EXPIRED/);
      expect(await fraction(f)).toMatchObject({ status: "available", currentContractId: null });
      expect((await contractRow(id)).inventoryLostAt).not.toBeNull();
      expect(await db.select().from(tasks).where(eq(tasks.automationKey, `inventory-lost:${id}`))).toHaveLength(1);
      // a conferência ficou registrada e a venda não valida
      expect((await api.getValidationStatus({ contractId: id })).documentsConferredAt).toBeTruthy();
      await expect(api.validateSale({ contractId: id })).rejects.toThrow();
      // evento interno contract.inventory_lost: exatamente um, mesmo repetindo a conferência
      expect(await lostEvents(id)).toHaveLength(1);
      await expect(api.confirmDocuments({ contractId: id, note: "documentação conferida" })).rejects.toThrow();
      expect(await lostEvents(id)).toHaveLength(1);
      // a cota livre pode ser vendida a outro contrato
      await createContract("again", f);
      expect((await fraction(f)).status).toBe("held");
    });

    it("reserva vencida varrida pelo sweep: 1 domain_event contract.inventory_lost; repetir o sweep continua 1", async () => {
      const f = await newFraction(); const id = await createContract("evt", f);
      await expireHolds(f);
      await sweepExpiredHolds(db as never, { actorUserId: adminId, fractionIds: [f] });
      const events = await lostEvents(id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ aggregateType: "contract", idempotencyKey: `inventory-lost:${id}` });
      expect(JSON.parse(events[0]!.payload)).toMatchObject({ contractId: id });
      await sweepExpiredHolds(db as never, { actorUserId: adminId, fractionIds: [f] });
      expect(await lostEvents(id)).toHaveLength(1);
    });

    it("conferência final concorrente com o sweep: nunca vende cota vencida e nunca dá deadlock", async () => {
      for (let round = 0; round < 3; round += 1) {
        const f = await newFraction(); const id = await createContract(`sweep${round}`, f);
        const api = await saleApi();
        await api.confirmPayment({ contractId: id, note: "comprovante conferido" });
        await expireHolds(f);
        const outcomes = await Promise.allSettled([
          api.confirmDocuments({ contractId: id, note: "documentação conferida" }),
          sweepExpiredHolds(db as never, { actorUserId: adminId, fractionIds: [f] }),
        ]);
        const sweep = outcomes[1];
        expect(sweep.status, String((sweep as PromiseRejectedResult).reason)).toBe("fulfilled");
        const confirm = outcomes[0];
        expect(confirm.status).toBe("rejected");
        expect(String((confirm as PromiseRejectedResult).reason)).toMatch(/INVENTORY_HELD_EXPIRED/);
        expect((await fraction(f)).status).toBe("available");
        expect((await contractRow(id)).inventoryLostAt).not.toBeNull();
        expect(await db.select().from(tasks).where(eq(tasks.automationKey, `inventory-lost:${id}`))).toHaveLength(1);
      }
    });

    it("segunda conferência relê as duas datas sob trava: duas conferências simultâneas vendem a cota uma única vez", async () => {
      const f = await newFraction(); const id = await createContract("both", f);
      const api = await saleApi();
      const outcomes = await Promise.allSettled([
        withDeadlockRetry(() => api.confirmPayment({ contractId: id, note: "comprovante conferido" })),
        withDeadlockRetry(() => api.confirmDocuments({ contractId: id, note: "documentação conferida" })),
      ]);
      expect(outcomes.map(item => item.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await fraction(f)).status).toBe("sold");
      const consumed = (await holds(f)).filter(item => item.status === "consumed");
      expect(consumed).toHaveLength(1);
    });

    it("Codex P1: flag desligada depois de criar o hold não encalha a cota — conferências ainda liquidam (vende) e a guarda do validateSale continua", async () => {
      const f = await newFraction(); const id = await createContract("flagoff", f);
      const api = await saleApi();
      process.env.INVENTORY_HOLD_AT_FORMALIZATION = "false";
      try {
        await expect(api.validateSale({ contractId: id })).rejects.toThrow(/INVENTORY_HELD_EXPIRED|SALE_/); // cota ainda held: nunca valida
        await api.confirmPayment({ contractId: id, note: "comprovante conferido" });
        await api.confirmDocuments({ contractId: id, note: "documentação conferida" });
      } finally { process.env.INVENTORY_HOLD_AT_FORMALIZATION = "true"; }
      expect((await fraction(f)).status).toBe("sold");
      const g = await newFraction(); const id2 = await createContract("flagoff2", g);
      process.env.INVENTORY_HOLD_AT_FORMALIZATION = "false";
      try {
        await api.confirmPayment({ contractId: id2, note: "comprovante conferido" });
        await expireHolds(g);
        await expect(api.confirmDocuments({ contractId: id2, note: "documentação conferida" })).rejects.toThrow(/INVENTORY_HELD_EXPIRED/);
        await expect(api.validateSale({ contractId: id2 })).rejects.toThrow();
      } finally { process.env.INVENTORY_HOLD_AT_FORMALIZATION = "true"; }
      expect((await fraction(g)).status).toBe("available");
    });

    it("Codex P1: caminhos genéricos de estoque não liberam nem reutilizam hold de formalização", async () => {
      const f = await newFraction(); const id = await createContract("generic", f);
      const [hold] = await holds(f);
      const inv = (await import("./routers/inventory")).inventoryRouter;
      const asAdmin = inv.createCaller({ user: { id: adminId, role: "admin" } } as never);
      await expect(asAdmin.releaseHold({ holdId: hold!.id, reason: "tentativa manual" })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(asAdmin.createHold({ fractionId: f } as never)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await fraction(f)).toMatchObject({ status: "held", currentContractId: id });
      expect((await contractRow(id)).inventoryLostAt).toBeNull();
      // vencido: createHold também recusa (o sweep marca a perda do contrato)
      await expireHolds(f);
      await expect(asAdmin.createHold({ fractionId: f } as never)).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("Codex P2: reserva perdida é fato persistido — repetir a conferência devolve o mesmo INVENTORY_HELD_EXPIRED, nunca sucesso", async () => {
      const f = await newFraction(); const id = await createContract("retry", f);
      const api = await saleApi();
      await api.confirmPayment({ contractId: id, note: "comprovante conferido" });
      await expireHolds(f);
      await expect(api.confirmDocuments({ contractId: id, note: "documentação conferida" })).rejects.toThrow(/INVENTORY_HELD_EXPIRED/);
      await expect(api.confirmDocuments({ contractId: id, note: "de novo" })).rejects.toThrow(/INVENTORY_HELD_EXPIRED/);
      await expect(api.confirmPayment({ contractId: id, note: "de novo" })).rejects.toThrow(/INVENTORY_HELD_EXPIRED/);
    });

    it("distrato executado antes da conferência libera a cota held e o hold ativo (executeCancellation de verdade)", async () => {
      const f = await newFraction(); const id = await createContract("cancel-real", f);
      expect((await fraction(f)).status).toBe("held");
      const requestId = (await db.insert(contractCancellationRequests).values({ contractId: id, status: "approved", reason: "Cliente desistiu (sintético)", simulationSnapshot: JSON.stringify({ paidAmount: 0, policyConfigured: false }), requestedByUserId: adminId, decidedByUserId: adminId }).$returningId())[0]!.id;
      await expect((await contractsApi()).executeCancellation({ requestId })).resolves.toMatchObject({ success: true, returnedFractionIds: [f] });
      expect(await fraction(f)).toMatchObject({ status: "available", currentContractId: null });
      const [hold] = await holds(f);
      expect(hold).toMatchObject({ status: "released", activeKey: null });
      const history = await db.select().from(commercialFractionHistory).where(eq(commercialFractionHistory.fractionId, f));
      expect(history.some(row => row.fromStatus === "held" && row.toStatus === "available" && row.contractId === id)).toBe(true);
      // a cota volta ao estoque e pode ser reservada por outro contrato
      await createContract("cancel-again", f);
      expect((await fraction(f)).status).toBe("held");
    });

    it("sweep devolve a cota de contrato cancelado cujo hold venceu", async () => {
      const f = await newFraction(); const id = await createContract("cancel", f);
      await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, id));
      // o ramo do distrato (executeCancellation) libera o hold no código; aqui só o sweep de um contrato já cancelado
      await expireHolds(f);
      await sweepExpiredHolds(db as never, { actorUserId: adminId, fractionIds: [f] });
      expect((await fraction(f)).status).toBe("available");
    });

    describe("ingestão do Sales", () => {
      const project = () => ({ externalKey: `e1-${runId}`, name: `SYN E1 ${runId}`, timezone: "America/Sao_Paulo" });
      const saleEvent = (saleId: string, quotasCount = 1): SalesCommandSale => ({
        eventId: `evt-${randomUUID()}`, eventName: "sale.ready_for_contract.v1", source: "sales-command", correlationId: `corr-${randomUUID()}`, occurredAt: "2026-10-04T15:30:00.000Z",
        project: project(), saleId, encounterId: `enc-${randomUUID()}`,
        customer: { name: `Casal E1 ${runId}`, phone: `+55119${Math.floor(Math.random() * 1e8)}` },
        sale: { quotasCount, vgvCents: 300_000, entryContractedCents: 100_000, entryReceivedCents: 0, entryInstallmentCount: 1, entrySchedule: [{ sequence: 1, amountCents: 100_000, dueDate: "2026-10-04" }], firstBalanceDueInDays: 30, paymentMethods: ["pix"] },
      });

      it("reserva as cotas (held, sem usuário) em vez de vender; estoque insuficiente continua recusado; replay com reserva perdida devolve 422", async () => {
        await newFraction();
        const event = saleEvent(`sale-${randomUUID()}`);
        const result = await withDeadlockRetry(() => db.transaction(tx => materializeSalesCommandSale(tx, event)));
        const f = await fraction(result.fractionIds[0]!);
        expect(f.status).toBe("held");
        const [hold] = await holds(f.id);
        expect(hold).toMatchObject({ purpose: "formalization", heldByUserId: null, contractId: result.contractId });

        await expect(db.transaction(tx => materializeSalesCommandSale(tx, saleEvent(`sale-${randomUUID()}`, 9999)))).rejects.toMatchObject({ code: "INSUFFICIENT_INVENTORY" });

        // expira e o sweep perde a reserva
        await expireHolds(f.id);
        await sweepExpiredHolds(db as never, { actorUserId: null, fractionIds: [f.id] });
        expect((await contractRow(result.contractId)).inventoryLostAt).not.toBeNull();

        let handler: ((req: unknown, res: unknown) => Promise<void>) | null = null;
        registerSalesCommandBridge({ post: (_path: string, fn: never) => { handler = fn; } } as never, "SYN-key");
        let status = 0; let body: unknown = null;
        const res = { headersSent: false, status(code: number) { status = code; return this; }, json(payload: unknown) { body = payload; return this; } };
        await handler!({ get: () => "Bearer SYN-key", body: event }, res);
        expect(status).toBe(422);
        expect(body).toMatchObject({ accepted: false, code: "INVENTORY_HELD_EXPIRED" });
      });
    });
  });
});
