import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, commercialFractions, commercialPolicyVersions, contracts, customers, opportunities, proposals, resorts, units } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { withDeadlockRetry } from "./mysqlErrors";
import { materializeSalesCommandSale, salesCommandSaleSchema, type SalesCommandSale } from "./salesCommandBridge";
import { nqByCoupleCode } from "./routers/captureSheet";

// F1.10 (homologação P4.5): a ficha nascida pela ponte de venda nascia com coupleCode NULL e não abria por /ficha?codigo=; a recepção abria outra ficha para o mesmo casal.
// MySQL descartável, dados sintéticos, nada de PII real.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("ponte de venda grava o coupleCode e não duplica a ficha do casal (MySQL real)", () => {
  let pool: mysql.Pool; let db: ReturnType<typeof drizzle>;
  const previousEnv = { ...process.env };
  let seq = 0;
  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 }); db = drizzle({ client: pool });
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });
  beforeEach(() => { delete process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED; });
  afterEach(() => { delete process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED; });

  async function seedProject(label: string) {
    const name = `F110 ${label} ${runId}`; const externalKey = `f110-${label}-${runId}`;
    const [resort] = await db.insert(resorts).values({ name, externalKey }).$returningId();
    const [unit] = await db.insert(units).values({ resortId: resort.id, code: `U-${label}-${runId}` }).$returningId();
    await db.insert(commercialPolicyVersions).values({ resortId: resort.id, policyType: "sale_terms", version: `f110-${label}`, policyJson: JSON.stringify({ usageModel: "fixed_week", balanceInstallmentCount: 3, balanceCadenceMonths: 1 }), effectiveAt: new Date("2026-01-01T00:00:00Z") });
    for (let sequence = 1; sequence <= 6; sequence++) await db.insert(commercialFractions).values({ resortId: resort.id, unitId: unit.id, code: `F-${label}-${runId}-${sequence}`, sequence, listPrice: "10000.00" });
    return { resortId: resort.id, project: { externalKey, name, timezone: "America/Sao_Paulo" } };
  }
  const phone = () => `1198${String(++seq).padStart(4, "0")}${Math.floor(Math.random() * 1e3).toString().padStart(3, "0")}`;
  function saleEvent(project: SalesCommandSale["project"], customer: { name: string; phone: string }, extra: { coupleCode?: string; occurredAt?: string } = {}): SalesCommandSale {
    return {
      eventId: `evt-${randomUUID()}`, eventName: "sale.ready_for_contract.v1", source: "sales-command", correlationId: `corr-${randomUUID()}`,
      occurredAt: extra.occurredAt ?? new Date().toISOString(), project, saleId: `sale-${randomUUID()}`, encounterId: `enc-${randomUUID()}`,
      ...(extra.coupleCode ? { coupleCode: extra.coupleCode } : {}),
      customer,
      sale: { quotasCount: 1, vgvCents: 900_000, entryContractedCents: 90_000, entryReceivedCents: 90_000, entryInstallmentCount: 1, entrySchedule: [{ sequence: 1, amountCents: 90_000, dueDate: "2026-10-04" }], firstBalanceDueInDays: 30, paymentMethods: ["pix"] },
    };
  }
  const ingest = (event: SalesCommandSale) => withDeadlockRetry(() => db.transaction(tx => materializeSalesCommandSale(tx, event)));
  const capturesOf = (customerId: number) => db.select().from(captureRecords).where(eq(captureRecords.customerId, customerId));
  async function receptionCustomer(label: string) {
    const customer = { name: `Casal ${label} ${runId}`, phone: phone() };
    const [{ id }] = await db.insert(customers).values({ fullName: customer.name, phone: customer.phone, status: "active" } as never).$returningId();
    return { id, ...customer };
  }

  it("evento com coupleCode: a ficha da venda nasce com o código e abre pela busca por código (antes: NULL)", async () => {
    const { project } = await seedProject("a");
    const code = `CP-F110${runId.toUpperCase()}A`;
    const result = await ingest(saleEvent(project, { name: `Casal Novo ${runId}`, phone: phone() }, { coupleCode: code }));
    const rows = await capturesOf(result.customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.coupleCode).toBe(code);
    expect(rows[0]!.opportunityId).toBe(result.opportunityId);
    // É a mesma busca que /ficha?codigo= e o endpoint do NQ usam.
    expect(await nqByCoupleCode(code)).toMatchObject({ coupleCode: code });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, String(rows[0]!.id)));
    expect(JSON.stringify(audit)).not.toContain(code);
  });

  it("ficha da recepção já tem o código: a venda se junta a ela (mesmo cliente, uma só ficha) e não toca no estado da sala", async () => {
    const { project, resortId } = await seedProject("b");
    const customer = await receptionCustomer("B");
    const code = `CP-F110${runId.toUpperCase()}B`;
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: customer.id, resortId, coupleCode: code, presentationStatus: "presented", checkedInAt: new Date(), captureLocation: "Recepção" } as never).$returningId();
    // O Sales manda outro nome/telefone para o casal: o código manda, não a grafia.
    const result = await ingest(saleEvent(project, { name: `Outra Grafia ${runId}`, phone: phone() }, { coupleCode: code }));
    expect(result.customerId).toBe(customer.id);
    const rows = await capturesOf(customer.id);
    expect(rows.map(row => row.id)).toEqual([captureId]);
    expect(rows[0]!.opportunityId).toBe(result.opportunityId);
    expect(rows[0]!.presentationStatus).toBe("presented");
    expect(rows[0]!.captureLocation).toBe("Recepção");
  });

  // Mesmo join do revenueQualitySync/contracts: contrato -> proposta -> oportunidade -> ficha (captureRecords.opportunityId).
  async function captureOfContract(contractId: number) {
    const rows = await db.select({ captureId: captureRecords.id, resortId: captureRecords.resortId }).from(contracts)
      .innerJoin(proposals, eq(proposals.id, contracts.proposalId))
      .innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
      .innerJoin(captureRecords, eq(captureRecords.opportunityId, opportunities.id))
      .where(eq(contracts.id, contractId));
    return rows;
  }
  const contractOf = async (result: { contractId: number }) => (await captureOfContract(result.contractId));

  it("ficha da recepção criada pelo caminho padrão (oportunidade 'new', resort NULL): a venda reaproveita a oportunidade e o contrato acha a ficha pelo join", async () => {
    const { project, resortId } = await seedProject("i");
    const customer = await receptionCustomer("I");
    const code = `CP-F110${runId.toUpperCase()}I`;
    const [{ id: receptionOppId }] = await db.insert(opportunities).values({ customerId: customer.id, title: "Recepção", stage: "new", source: "Recepção" } as never).$returningId();
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: customer.id, resortId: null, opportunityId: receptionOppId, coupleCode: code, presentationStatus: "presented", checkedInAt: new Date(), captureLocation: "Recepção" } as never).$returningId();
    const result = await ingest(saleEvent(project, { name: `Outra Grafia ${runId}`, phone: phone() }, { coupleCode: code }));
    expect(result.opportunityId).toBe(receptionOppId);
    const opps = await db.select().from(opportunities).where(eq(opportunities.customerId, customer.id));
    expect(opps).toHaveLength(1);
    expect(opps[0]!.stage).toBe("won");
    const found = await contractOf(result);
    expect(found).toEqual([{ captureId, resortId }]);
    const rows = await capturesOf(customer.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.presentationStatus).toBe("presented");
    expect(rows[0]!.captureLocation).toBe("Recepção");
  });

  it("ficha da recepção com oportunidade já perdida: a ficha passa a apontar para a oportunidade da venda", async () => {
    const { project, resortId } = await seedProject("j");
    const customer = await receptionCustomer("J");
    const code = `CP-F110${runId.toUpperCase()}J`;
    const [{ id: lostOppId }] = await db.insert(opportunities).values({ customerId: customer.id, title: "Perdida", stage: "lost", lossReason: "teste" } as never).$returningId();
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: customer.id, resortId, opportunityId: lostOppId, coupleCode: code, checkedInAt: new Date() } as never).$returningId();
    const result = await ingest(saleEvent(project, customer, { coupleCode: code }));
    expect(result.opportunityId).not.toBe(lostOppId);
    expect(await contractOf(result)).toEqual([{ captureId, resortId }]);
  });

  it("ficha com o MESMO código mas resort de OUTRO projeto não é reaproveitada: a venda cria a sua ficha (sem o código, já ocupado) e a ficha alheia fica intacta", async () => {
    const { project, resortId } = await seedProject("k");
    const other = await seedProject("k2");
    const customer = await receptionCustomer("K");
    const code = `CP-F110${runId.toUpperCase()}K`;
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: customer.id, resortId: other.resortId, coupleCode: code, checkedInAt: new Date() } as never).$returningId();
    const result = await ingest(saleEvent(project, customer, { coupleCode: code }));
    const [row] = await db.select().from(captureRecords).where(eq(captureRecords.id, captureId));
    expect(row).toMatchObject({ resortId: other.resortId, coupleCode: code, opportunityId: null });
    const mine = await capturesOf(customer.id);
    expect(mine).toHaveLength(2);
    const created = mine.find(r => r.id !== captureId)!;
    expect(created).toMatchObject({ resortId, coupleCode: null, opportunityId: result.opportunityId });
    expect(await contractOf(result)).toEqual([{ captureId: created.id, resortId }]);
  });

  it("flag LIGADA: a única ficha recente do cliente é de OUTRO resort: não é reaproveitada (cria a ficha da venda)", async () => {
    process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED = "true";
    const { project, resortId } = await seedProject("n");
    const other = await seedProject("n2");
    const customer = await receptionCustomer("N");
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: customer.id, resortId: other.resortId, presentationStatus: "checked_in", checkedInAt: new Date(), captureLocation: "Recepção" } as never).$returningId();
    const result = await ingest(saleEvent(project, customer, { coupleCode: `CP-F110${runId.toUpperCase()}N` }));
    const [row] = await db.select().from(captureRecords).where(eq(captureRecords.id, captureId));
    expect(row).toMatchObject({ resortId: other.resortId, coupleCode: null, opportunityId: null });
    const mine = await capturesOf(customer.id);
    expect(mine).toHaveLength(2);
    expect(mine.find(r => r.id !== captureId)).toMatchObject({ resortId, opportunityId: result.opportunityId });
  });

  it("flag LIGADA: ficha de outro resort + ficha do resort da venda: só a do resort da venda é candidata (não é ambíguo)", async () => {
    process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED = "true";
    const { project, resortId } = await seedProject("o");
    const other = await seedProject("o2");
    const customer = await receptionCustomer("O");
    await db.insert(captureRecords).values({ customerId: customer.id, resortId: other.resortId, presentationStatus: "checked_in", checkedInAt: new Date(), captureLocation: "Recepção" } as never);
    const [{ id: mineId }] = await db.insert(captureRecords).values({ customerId: customer.id, resortId, presentationStatus: "checked_in", checkedInAt: new Date(), captureLocation: "Recepção" } as never).$returningId();
    const result = await ingest(saleEvent(project, customer));
    expect(await capturesOf(customer.id)).toHaveLength(2);
    expect(await contractOf(result)).toEqual([{ captureId: mineId, resortId }]);
  });

  it("flag LIGADA: ficha da recepção SEM local de captação e com oportunidade aberta (caminho padrão) é reaproveitada", async () => {
    process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED = "true";
    const { project, resortId } = await seedProject("l");
    const customer = await receptionCustomer("L");
    const code = `CP-F110${runId.toUpperCase()}L`;
    const [{ id: oppId }] = await db.insert(opportunities).values({ customerId: customer.id, title: "Recepção", stage: "new" } as never).$returningId();
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: customer.id, resortId: null, opportunityId: oppId, presentationStatus: "checked_in", checkedInAt: new Date(), captureLocation: null } as never).$returningId();
    const result = await ingest(saleEvent(project, customer, { coupleCode: code }));
    const rows = await capturesOf(customer.id);
    expect(rows.map(row => row.id)).toEqual([captureId]);
    expect(rows[0]!.coupleCode).toBe(code);
    expect(rows[0]!.resortId).toBe(resortId);
    expect(result.opportunityId).toBe(oppId);
    expect(await contractOf(result)).toEqual([{ captureId, resortId }]);
  });

  it("flag LIGADA: ficha da recepção cuja oportunidade já foi ganha não é reaproveitada", async () => {
    process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED = "true";
    const { project, resortId } = await seedProject("m");
    const customer = await receptionCustomer("M");
    const [{ id: oppId }] = await db.insert(opportunities).values({ customerId: customer.id, title: "Ganha", stage: "won" } as never).$returningId();
    await db.insert(captureRecords).values({ customerId: customer.id, resortId, opportunityId: oppId, checkedInAt: new Date(), captureLocation: "Recepção" } as never);
    await ingest(saleEvent(project, customer));
    expect(await capturesOf(customer.id)).toHaveLength(2);
  });

  it("código já ligado a uma ficha de OUTRO cliente anonimizado não derruba a venda (sem reaproveitar)", async () => {
    const { project, resortId } = await seedProject("c");
    const customer = await receptionCustomer("C");
    const code = `CP-F110${runId.toUpperCase()}C`;
    await db.insert(captureRecords).values({ customerId: customer.id, resortId, coupleCode: code, anonymizedAt: new Date(), presentationStatus: "closed" } as never);
    const result = await ingest(saleEvent(project, { name: `Casal C2 ${runId}`, phone: phone() }, { coupleCode: code }));
    expect(result.replay).toBe(false);
    const mine = await capturesOf(result.customerId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.coupleCode).toBeNull();
  });

  it("flag DESLIGADA (padrão): ficha da recepção sem código não é reaproveitada, como antes", async () => {
    const { project, resortId } = await seedProject("d");
    const customer = await receptionCustomer("D");
    await db.insert(captureRecords).values({ customerId: customer.id, resortId, presentationStatus: "checked_in", checkedInAt: new Date(), captureLocation: "Recepção" } as never);
    const result = await ingest(saleEvent(project, customer, { coupleCode: `CP-F110${runId.toUpperCase()}D` }));
    expect(result.customerId).toBe(customer.id);
    expect(await capturesOf(customer.id)).toHaveLength(2);
  });

  it("flag LIGADA: a única ficha recente da recepção do mesmo cliente é reaproveitada e recebe o código; duplicada não nasce", async () => {
    process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED = "true";
    const { project, resortId } = await seedProject("e");
    const customer = await receptionCustomer("E");
    const code = `CP-F110${runId.toUpperCase()}E`;
    const [{ id: captureId }] = await db.insert(captureRecords).values({ customerId: customer.id, resortId, presentationStatus: "checked_in", checkedInAt: new Date(), captureLocation: "Recepção" } as never).$returningId();
    const result = await ingest(saleEvent(project, customer, { coupleCode: code }));
    const rows = await capturesOf(customer.id);
    expect(rows.map(row => row.id)).toEqual([captureId]);
    expect(rows[0]!.coupleCode).toBe(code);
    expect(rows[0]!.opportunityId).toBe(result.opportunityId);
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, result.opportunityId));
    expect(opp!.stage).toBe("won");
  });

  it("flag LIGADA: duas fichas candidatas = ambíguo, não adivinha e cria a ficha da venda", async () => {
    process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED = "true";
    const { project, resortId } = await seedProject("f");
    const customer = await receptionCustomer("F");
    for (let i = 0; i < 2; i++) await db.insert(captureRecords).values({ customerId: customer.id, resortId, presentationStatus: "checked_in", checkedInAt: new Date(), captureLocation: "Recepção" } as never);
    await ingest(saleEvent(project, customer));
    expect(await capturesOf(customer.id)).toHaveLength(3);
  });

  it("flag LIGADA: ficha antiga (fora da janela da visita) não é reaproveitada", async () => {
    process.env.SALE_BRIDGE_REUSE_CAPTURE_ENABLED = "true";
    const { project, resortId } = await seedProject("g");
    const customer = await receptionCustomer("G");
    const old = new Date(Date.now() - 5 * 86_400_000);
    await db.insert(captureRecords).values({ customerId: customer.id, resortId, presentationStatus: "closed", checkedInAt: old, createdAt: old, captureLocation: "Recepção" } as never);
    await ingest(saleEvent(project, customer));
    expect(await capturesOf(customer.id)).toHaveLength(2);
  });

  it("replay do mesmo saleId não cria ficha nem tenta o código de novo", async () => {
    const { project } = await seedProject("h");
    const event = saleEvent(project, { name: `Casal H ${runId}`, phone: phone() }, { coupleCode: `CP-F110${runId.toUpperCase()}H` });
    const first = await ingest(event);
    const again = await ingest(event);
    expect(again.replay).toBe(true);
    expect(await capturesOf(first.customerId)).toHaveLength(1);
  });
});

describe("corpo da venda: coupleCode é opcional no contrato", () => {
  const base = {
    eventId: "e1", eventName: "sale.ready_for_contract.v1", source: "sales-command", correlationId: "c1", occurredAt: "2026-10-04T15:30:00.000Z",
    project: { externalKey: "k", name: "P", timezone: "America/Sao_Paulo" }, saleId: "s1", encounterId: "enc1", customer: { name: "Casal Teste" },
    sale: { quotasCount: 1, vgvCents: 1000, entryContractedCents: 100, entryReceiptClaimedCents: 100, entryInstallmentCount: 1, entrySchedule: [{ sequence: 1, amountCents: 100, dueDate: "2026-10-04" }], firstBalanceDueInDays: 30, paymentMethods: ["pix"] },
  };
  it("sem coupleCode segue válido (corpo atual do Sales); com coupleCode também; vazio ou com 65 caracteres é recusado", () => {
    expect(salesCommandSaleSchema.safeParse(base).success).toBe(true);
    const withCode = salesCommandSaleSchema.safeParse({ ...base, coupleCode: " CP-SYN00001 " });
    expect(withCode.success && withCode.data.coupleCode).toBe("CP-SYN00001");
    expect(salesCommandSaleSchema.safeParse({ ...base, coupleCode: "" }).success).toBe(false);
    expect(salesCommandSaleSchema.safeParse({ ...base, coupleCode: "C".repeat(65) }).success).toBe(false);
    expect(salesCommandSaleSchema.safeParse({ ...base, couple_code: "x" }).success).toBe(false);
  });
});
