import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { captureRecords, commercialPolicyVersions, commercialProjectSettings, contractDocuments, contracts, customers, installments, opportunities, proposals, resorts, salesCommissions, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// CRM-F1 + D2=B em MySQL real: a política de comissão é escolhida por vigência (data do VENDEU, o fato original; não a da parcela paga nem a de hoje), atrás de flag; legado intacto com a flag desligada. Dados SYN-.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const policy = (rate: number) => JSON.stringify({ linerRate: rate, closerRate: rate, ftbRate: 0, cancellationDeadlineDay: 7, expectedPaymentDay: 25, eligiblePaymentMethods: ["pix", "boleto"], basis: "eligible_receipt" });

describe.skipIf(!integrationUrl)("F1: política de comissão por vigência", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let svc: typeof import("./saleValidationService");
  let adminId = 0;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    svc = await import("./saleValidationService");
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    adminId = (await db.insert(users).values({ openId: `f1-admin-${runId}`, name: "SYN admin", role: "admin" }).$returningId())[0]!.id;
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const newResort = async (label: string, legacy: string | null) => {
    const id = (await db.insert(resorts).values({ name: `Resort F1 ${label} ${runId}` } as never).$returningId())[0]!.id;
    if (legacy) await db.insert(commercialProjectSettings).values({ resortId: id, commissionPolicy: legacy });
    return id;
  };
  const addVersion = (resortId: number, version: string, json: string, effectiveAt: string, retiredAt?: string) =>
    db.insert(commercialPolicyVersions).values({ resortId, policyType: "commission", version, policyJson: json, effectiveAt: new Date(effectiveAt), ...(retiredAt ? { retiredAt: new Date(retiredAt) } : {}) });
  const resolve = async (resortId: number, at: string) => (await import("./commissionPolicyVersion")).resolveCommissionPolicy(db as never, resortId, new Date(at));

  it("flag desligada: só o legado é lido, mesmo havendo versões", async () => {
    delete process.env.COMMISSION_POLICY_VERSIONING_ENABLED;
    const resort = await newResort("off", policy(0.01));
    await addVersion(resort, "v2026-02", policy(0.05), "2026-02-01T00:00:00Z");
    const result = await resolve(resort, "2026-03-01T00:00:00Z");
    expect(result).toMatchObject({ source: "legacy", version: "legacy" });
    expect(result.policy?.linerRate).toBe(0.01);
  });

  describe("flag ligada", () => {
    beforeAll(() => { process.env.COMMISSION_POLICY_VERSIONING_ENABLED = "true"; });
    afterAll(() => { delete process.env.COMMISSION_POLICY_VERSIONING_ENABLED; });

    it("escolhe a versão por effectiveAt <= data (âncora) < retiredAt; antes de qualquer versão vale o legado", async () => {
      const resort = await newResort("on", policy(0.01));
      await addVersion(resort, "v1", policy(0.02), "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z");
      await addVersion(resort, "v2", policy(0.03), "2026-04-01T00:00:00Z");
      expect(await resolve(resort, "2026-01-15T00:00:00Z")).toMatchObject({ source: "legacy" });
      expect((await resolve(resort, "2026-03-31T23:59:59Z")).policy?.linerRate).toBe(0.02);
      expect(await resolve(resort, "2026-03-31T23:59:59Z")).toMatchObject({ version: "v1", source: "versioned" });
      expect((await resolve(resort, "2026-04-01T00:00:00Z")).policy?.linerRate).toBe(0.03);
    });

    it("versão vigente ilegível fecha (sem política), não cai no legado em silêncio", async () => {
      const resort = await newResort("bad", policy(0.01));
      await addVersion(resort, "quebrada", "{nao-json", "2026-02-01T00:00:00Z");
      expect(await resolve(resort, "2026-03-01T00:00:00Z")).toMatchObject({ policy: null, version: "quebrada", source: "versioned" });
    });

    it("Opus: vigência retroativa é recusada para commission e stock_hold; futura e atual passam", async () => {
      const resort = await newResort("retro", null);
      const api = (await import("./routers/commercialPolicies")).commercialPoliciesRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
      const past = new Date(Date.now() - 3_600_000);
      await expect(api.create({ resortId: resort, policyType: "commission", version: "retro", policy: JSON.parse(policy(0.02)), effectiveAt: past } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(api.create({ resortId: resort, policyType: "stock_hold", version: "retro", policy: { ttlHours: 2 }, effectiveAt: past } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(api.create({ resortId: resort, policyType: "commission", version: "agora", policy: JSON.parse(policy(0.02)) } as never)).resolves.toMatchObject({ id: expect.any(Number) });
      await expect(api.create({ resortId: resort, policyType: "commission", version: "futura", policy: JSON.parse(policy(0.03)), effectiveAt: new Date(Date.now() + 86_400_000) } as never)).resolves.toMatchObject({ id: expect.any(Number) });
    });

    it("a criação de versão 'commission' recusa política incompleta", async () => {
      const resort = await newResort("create", null);
      const api = (await import("./routers/commercialPolicies")).commercialPoliciesRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
      await expect(api.create({ resortId: resort, policyType: "commission", version: "ruim", policy: { linerRate: 0.1 } } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(api.create({ resortId: resort, policyType: "commission", version: "boa", policy: JSON.parse(policy(0.02)) } as never)).resolves.toMatchObject({ id: expect.any(Number) });
    });

    it("Opus: commercialPolicies.create MATERIALIZA releaseOn=entry_total no JSON gravado (full_upfront sem releaseOn); explícito e per_installment ficam como estão", async () => {
      const resort = await newResort("materializa", null);
      const api = (await import("./routers/commercialPolicies")).commercialPoliciesRouter.createCaller({ user: { id: adminId, role: "admin" } } as never);
      const stored = async (version: string, extra: object) => {
        const { id } = await api.create({ resortId: resort, policyType: "commission", version, policy: { ...JSON.parse(policy(0.02)), ...extra } } as never);
        return JSON.parse((await db.select().from(commercialPolicyVersions).where(eq(commercialPolicyVersions.id, id)))[0]!.policyJson);
      };
      expect((await stored("m-sem", {})).payoutSchedule).toEqual({ mode: "full_upfront", releaseOn: "entry_total" });
      expect((await stored("m-full", { payoutSchedule: { mode: "full_upfront" } })).payoutSchedule).toEqual({ mode: "full_upfront", releaseOn: "entry_total" });
      expect((await stored("m-expl", { payoutSchedule: { mode: "full_upfront", releaseOn: "first_entry_installment" } })).payoutSchedule).toEqual({ mode: "full_upfront", releaseOn: "first_entry_installment" });
      expect((await stored("m-per", { payoutSchedule: { mode: "per_installment" } })).payoutSchedule).toEqual({ mode: "per_installment" });
    });

    it("a baixa de parcela grava a versão aplicada na comissão (policyVersion)", async () => {
      const resort = await newResort("e2e", policy(0.01));
      await addVersion(resort, "vigente-f1", policy(0.1), "2026-01-01T00:00:00Z");
      const liner = (await db.insert(users).values({ openId: `f1-liner-${runId}`, name: "Liner", role: "seller" }).$returningId())[0]!.id;
      const closer = (await db.insert(users).values({ openId: `f1-closer-${runId}`, name: "Closer", role: "seller" }).$returningId())[0]!.id;
      const customer = (await db.insert(customers).values({ fullName: `SYN F1 ${runId}`, status: "active" }).$returningId())[0]!.id;
      const opp = (await db.insert(opportunities).values({ customerId: customer, title: "Opp F1", sellerId: closer } as never).$returningId())[0]!.id;
      const proposal = (await db.insert(proposals).values({ opportunityId: opp, reference: `P-F1-${runId}`, productDescription: "Semana", totalAmount: "10000.00", downPaymentAmount: "1000.00", installmentCount: 3 }).$returningId())[0]!.id;
      await db.insert(captureRecords).values({ customerId: customer, resortId: resort, opportunityId: opp, linerId: liner, closerId: closer } as never);
      const contract = (await db.insert(contracts).values({ number: `F1-${runId}`, customerId: customer, proposalId: proposal, status: "pending_signature", totalAmount: "10000.00", signedAt: new Date() }).$returningId())[0]!.id;
      await db.insert(contractDocuments).values({ contractId: contract, category: "Contrato assinado", filename: "c.pdf", storageKey: `contracts/f1-${runId}.pdf`, signed: true, signedArtifact: true });
      const inst = (await db.insert(installments).values({ contractId: contract, sequence: 1, dueDate: new Date("2026-10-10T12:00:00Z"), amount: "1000.00", status: "open", paidAmount: "0.00" }).$returningId())[0]!.id;
      await svc.confirmPayment(adminId, { contractId: contract, note: "conferido" });
      await svc.validateSale(adminId, { contractId: contract });
      await db.update(contracts).set({ status: "active" }).where(eq(contracts.id, contract));
      const finance = (await import("./routers/finance")).financeRouter.createCaller({ user: { id: adminId, role: "finance" } } as never);
      await finance.markInstallmentPaid({ id: inst, paymentMethod: "pix" });
      const rows = await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contract));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.policyVersion === "vigente-f1")).toBe(true);
    });

    async function seedPaid(label: string, resort: number, paidAts: string[], vendeuAt?: string) {
      const liner = (await db.insert(users).values({ openId: `f1-l-${label}-${runId}`, name: "Liner", role: "seller" }).$returningId())[0]!.id;
      const closer = (await db.insert(users).values({ openId: `f1-c-${label}-${runId}`, name: "Closer", role: "seller" }).$returningId())[0]!.id;
      const customer = (await db.insert(customers).values({ fullName: `SYN F1 ${label} ${runId}`, status: "active" }).$returningId())[0]!.id;
      const opp = (await db.insert(opportunities).values({ customerId: customer, title: `Opp ${label}`, sellerId: closer } as never).$returningId())[0]!.id;
      const proposal = (await db.insert(proposals).values({ opportunityId: opp, reference: `P-F1-${label}-${runId}`, productDescription: "Semana", totalAmount: "10000.00", downPaymentAmount: "2000.00", installmentCount: 3 }).$returningId())[0]!.id;
      await db.insert(captureRecords).values({ customerId: customer, resortId: resort, opportunityId: opp, linerId: liner, closerId: closer, ...(vendeuAt ? { commercialOutcome: "vendeu", commercialOutcomeAt: new Date(vendeuAt) } : {}) } as never);
      const contract = (await db.insert(contracts).values({ number: `F1-${label}-${runId}`, customerId: customer, proposalId: proposal, status: "pending_signature", totalAmount: "10000.00", signedAt: new Date() }).$returningId())[0]!.id;
      await db.insert(contractDocuments).values({ contractId: contract, category: "Contrato assinado", filename: "c.pdf", storageKey: `contracts/f1-${label}-${runId}.pdf`, signed: true, signedArtifact: true });
      const ids: number[] = [];
      for (const [index, paidAt] of paidAts.entries()) ids.push((await db.insert(installments).values({ contractId: contract, sequence: index + 1, dueDate: new Date(paidAt), amount: "1000.00", status: "paid", paidAmount: "1000.00", paidAt: new Date(paidAt) }).$returningId())[0]!.id);
      return { contract, ids };
    }
    const validate = async (contract: number) => { await svc.confirmPayment(adminId, { contractId: contract, note: "conferido" }); await svc.validateSale(adminId, { contractId: contract }); };

    it("D2=B: a versão da política é a da data do VENDEU para TODAS as parcelas, mesmo pagas depois de a política mudar", async () => {
      const resort = await newResort("perinst", null);
      await addVersion(resort, "jan", policy(0.02), "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z");
      await addVersion(resort, "abr", policy(0.03), "2026-04-01T00:00:00Z");
      const early = await seedPaid("perinst", resort, ["2026-02-10T12:00:00Z", "2026-05-10T12:00:00Z"], "2026-02-05T12:00:00Z");
      await validate(early.contract);
      const late = await seedPaid("perinst2", resort, ["2026-05-12T12:00:00Z"], "2026-05-01T12:00:00Z");
      await validate(late.contract);
      const rowsOf = (contract: number) => db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contract));
      const earlyRows = await rowsOf(early.contract);
      expect(earlyRows.length).toBeGreaterThan(0);
      expect([...new Set(earlyRows.map(row => row.policyVersion))]).toEqual(["jan"]); // a parcela paga em maio NÃO muda para "abr"
      const lateRows = await rowsOf(late.contract);
      expect([...new Set(lateRows.map(row => row.policyVersion))]).toEqual(["abr"]);
      const linerOf = (rows: typeof earlyRows, installmentId: number) => rows.filter(row => row.sourceInstallmentId === installmentId && row.commissionRole === "liner").map(row => Number(row.amount))[0];
      expect(linerOf(earlyRows, early.ids[1]!)).toBe(linerOf(earlyRows, early.ids[0]!));
    });

    it("D2=B: reprocesso usa a política do VENDEU (taxa zero da época não gera comissão com a taxa de hoje, mesmo pago depois)", async () => {
      const resort = await newResort("reproc", null);
      await addVersion(resort, "epoca-zero", policy(0), "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z");
      await addVersion(resort, "hoje", policy(0.05), "2026-04-01T00:00:00Z");
      const { contract, ids } = await seedPaid("reproc", resort, ["2026-05-10T12:00:00Z"], "2026-02-05T12:00:00Z");
      await validate(contract);
      expect(await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contract))).toHaveLength(0);
      const { recordZeroRateSkip, reprocessSkippedCommissions } = svc;
      await db.transaction(tx => recordZeroRateSkip(tx as never, { installmentId: ids[0]!, contractId: contract, resortId: resort, roles: ["liner", "closer"], actorUserId: adminId, source: "sale_validation" }));
      await db.update(contracts).set({ status: "active" }).where(eq(contracts.id, contract));
      const summary = await reprocessSkippedCommissions(db as never, { contractId: contract, actorUserId: adminId });
      expect(summary.created).toBe(0);
      expect(await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contract))).toHaveLength(0);
    });

    it("D2=B: versão do VENDEU ilegível bloqueia o reprocesso mesmo com a política de hoje válida", async () => {
      const resort = await newResort("reproc2", null);
      await addVersion(resort, "epoca-quebrada", "{x", "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z");
      await addVersion(resort, "hoje", policy(0.05), "2026-04-01T00:00:00Z");
      const { contract, ids } = await seedPaid("reproc2", resort, ["2026-05-10T12:00:00Z"], "2026-02-05T12:00:00Z");
      await validate(contract);
      await db.transaction(tx => svc.recordZeroRateSkip(tx as never, { installmentId: ids[0]!, contractId: contract, resortId: resort, roles: ["liner"], actorUserId: adminId, source: "sale_validation" }));
      await db.update(contracts).set({ status: "active" }).where(eq(contracts.id, contract));
      const summary = await svc.reprocessSkippedCommissions(db as never, { contractId: contract, actorUserId: adminId });
      expect(summary.created).toBe(0);
      expect(await db.select().from(salesCommissions).where(eq(salesCommissions.contractId, contract))).toHaveLength(0);
    });

    it("D2=B: âncora = VENDEU da ficha; sem VENDEU, a criação do contrato (nunca 'agora' quando o contrato existe)", async () => {
      const { commissionPolicyAnchor } = await import("./commissionPolicyVersion");
      const vendeu = new Date("2026-02-05T12:00:00Z"); const created = new Date("2026-03-01T00:00:00Z");
      expect(commissionPolicyAnchor({ commercialOutcome: "vendeu", commercialOutcomeAt: vendeu }, { createdAt: created })).toEqual(vendeu);
      expect(commissionPolicyAnchor({ commercialOutcome: "caiu_em_mesa", commercialOutcomeAt: vendeu }, { createdAt: created })).toEqual(created);
      expect(commissionPolicyAnchor(null, { createdAt: created })).toEqual(created);
      const now = new Date("2026-10-25T00:00:00Z");
      expect(commissionPolicyAnchor(null, null, now)).toEqual(now);
    });

    it("D2=B: modo de cancelamento de comissão PAGA usa a política do VENDEU, não a vigente no dia do distrato", async () => {
      process.env.COMMISSION_CANCEL_POLICY_ENABLED = "true";
      try {
        const { paidCommissionCancellationMode } = await import("./commissionPolicyVersion");
        const resort = await newResort("cancelmode", null);
        await addVersion(resort, "v-none", JSON.stringify({ ...JSON.parse(policy(0.02)), onPaidCommissionCancellation: "none" }), "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z");
        await addVersion(resort, "v-review", JSON.stringify({ ...JSON.parse(policy(0.02)), onPaidCommissionCancellation: "manual_review" }), "2026-04-01T00:00:00Z");
        expect(await paidCommissionCancellationMode(db as never, resort, new Date("2026-02-05T12:00:00Z"))).toBe("none");
        expect(await paidCommissionCancellationMode(db as never, resort, new Date("2026-10-25T00:00:00Z"))).toBe("manual_review");
      } finally { delete process.env.COMMISSION_CANCEL_POLICY_ENABLED; }
    });
  });
});
