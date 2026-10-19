import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureErasureRequests, captureRecords, contracts, csvImportItems, customerContacts, customerInteractions, customers, domainEvents, opportunities, users, vouchers } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
import { runTriggerDdl } from "./mysqlTestDdl";

// CRM-A18 em MySQL real: pedido de exclusão/anonimização do titular. Dois passos com trilha (registrar, cumprir digitando o código),
// só admin cumpre, sobra o registro mínimo (nome, CPF, data do brinde), guarda legal recusa, falha no meio desfaz tudo. Dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("pedido de exclusão/anonimização da ficha em MySQL real (CRM-A18)", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  const ids: Record<string, number> = {};
  const previousEnv = { ...process.env };
  const triggers: string[] = [];
  const as = (role: "admin" | "finance" | "seller" | "service") => appRouter.createCaller({ user: { id: ids[role], role, name: `Teste ${role}` } } as never);
  const code = (label: string) => `ERA-${label}-${runId}`;

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    for (const role of ["admin", "finance", "seller", "service"] as const) [{ id: ids[role] }] = await db.insert(users).values({ openId: `era-${role}-${runId}`, name: `Teste ${role}`, role }).$returningId();
  });
  afterEach(async () => { for (const name of triggers.splice(0)) await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``); });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  /** Cliente sintético com tudo preenchido, uma ou mais fichas (códigos), contatos, interação, oportunidade e um voucher. */
  async function seed(label: string, sheets = 1, document?: string) {
    const [{ id: customerId }] = await db.insert(customers).values({
      fullName: `Casal Sintético ${label} ${runId}`, documentNumber: document ?? `ERA${label}${runId}`.slice(0, 32), email: `${label}@exemplo.test`, phone: "11911112222", birthDate: new Date("1980-05-05T12:00:00Z"),
      maritalStatus: "Casado", occupation: "Engenheiro", zipCode: "01001000", address: "Rua Sintética", addressNumber: "10", complement: "ap 2", neighborhood: "Centro", city: "Natal", state: "RN", acquisitionSource: "Praia", status: "active", notes: "cliente pediu contato à noite",
    }).$returningId();
    await db.insert(customerContacts).values([{ customerId, kind: "phone", value: "11933334444" }, { customerId, kind: "email", value: `${label}-2@exemplo.test` }]);
    await db.insert(customerInteractions).values({ customerId, type: "note", subject: "Assunto sensível", content: "Conversa com dado pessoal" });
    const [{ id: opportunityId }] = await db.insert(opportunities).values({ customerId, title: `Oportunidade de Fulano ${label}`, lossReason: "esposa não gostou" } as never).$returningId();
    const captureIds: number[] = [];
    for (let n = 0; n < sheets; n += 1) {
      const [{ id }] = await db.insert(captureRecords).values({
        customerId, opportunityId: n === 0 ? opportunityId : null, coupleCode: code(`${label}${n}`), salesRoom: `Sala ${runId}`, lodgingLocation: "Hotel X", receptionNotes: "nota da recepção", partnerName: "Cônjuge Sintético", partnerAge: 41, relationshipStatus: "Casado", averageIncome: "15000.00",
        vehicleBrand: "Marca", vehicleModel: "Modelo", vehicleYear: 2021, childrenCount: 2, childrenNames: "Filho A, Filho B", socialNetworks: "@sintetico", giftDescription: "Jantar para dois", notes: "obs livre", guest1Name: "Convidado", maleSpouse: "titular", vehicleKind: "carro", ntComplement: "complemento",
      } as never).$returningId();
      captureIds.push(id);
    }
    await db.insert(vouchers).values({ code: `V${label}${runId}`.slice(0, 16), customerId, captureId: captureIds[0], description: "Jantar para dois", issuedAt: new Date("2026-10-10T15:00:00Z"), redeemNote: "resgatou com a esposa" });
    return { customerId, captureIds, codes: captureIds.map((_, n) => code(`${label}${n}`)) };
  }

  it("fluxo completo: pedido (finance), confirmação errada não faz nada, confirmação certa (admin) deixa só nome, CPF e a data do brinde, com trilha", async () => {
    const { customerId, captureIds, codes } = await seed("fluxo");
    await expect(as("seller").captureSheet.erasure.request({ code: codes[0], reason: "titular pediu pelo canal" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("finance").captureSheet.erasure.request({ code: codes[0], reason: "abc" })).rejects.toBeDefined(); // motivo precisa de 5+ caracteres
    await expect(as("finance").captureSheet.erasure.request({ code: "NAO-EXISTE-X", reason: "titular pediu pelo canal" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { requestId } = await as("finance").captureSheet.erasure.request({ code: codes[0], reason: "titular pediu pelo canal" });
    await expect(as("finance").captureSheet.erasure.request({ code: codes[0], reason: "titular pediu de novo" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); // pedido aberto

    // Quem registra não cumpre; o administrativo financeiro nem vê o botão de cumprir.
    await expect(as("finance").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Confirmação errada: nada muda.
    await expect(as("admin").captureSheet.erasure.complete({ requestId, confirmCode: "outro-codigo" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await db.select().from(customers).where(eq(customers.id, customerId)))[0]).toMatchObject({ phone: "11911112222", anonymizedAt: null });

    const done = await as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] });
    expect(done).toMatchObject({ requestId, sheetsAnonymized: 1 });
    expect(done.giftDate.toISOString()).toBe("2026-10-10T15:00:00.000Z");

    const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
    expect(customer).toMatchObject({ fullName: `Casal Sintético fluxo ${runId}`, documentNumber: `ERAfluxo${runId}`, email: null, phone: null, birthDate: null, maritalStatus: null, occupation: null, zipCode: null, address: null, addressNumber: null, complement: null, neighborhood: null, city: null, state: null, acquisitionSource: null, notes: null, status: "inactive" });
    expect(customer.anonymizedAt).toBeInstanceOf(Date);
    expect(await db.select().from(customerContacts).where(eq(customerContacts.customerId, customerId))).toHaveLength(0);
    expect((await db.select().from(customerInteractions).where(eq(customerInteractions.customerId, customerId)))[0]).toMatchObject({ subject: null, content: "[removido a pedido do titular]" });
    expect((await db.select().from(opportunities).where(eq(opportunities.customerId, customerId)))[0]).toMatchObject({ title: "Oportunidade anonimizada", lossReason: null });
    expect((await db.select().from(vouchers).where(eq(vouchers.customerId, customerId)))[0]).toMatchObject({ description: "Jantar para dois", redeemNote: null });

    const [sheet] = await db.select().from(captureRecords).where(eq(captureRecords.id, captureIds[0]));
    expect(sheet).toMatchObject({ coupleCode: codes[0], salesRoom: `Sala ${runId}`, lodgingLocation: null, receptionNotes: null, partnerName: null, partnerAge: null, relationshipStatus: null, averageIncome: null, vehicleBrand: null, vehicleModel: null, vehicleYear: null, childrenCount: 0, childrenNames: null, socialNetworks: null, giftDescription: null, notes: null, guest1Name: null, maleSpouse: null, vehicleKind: null, ntComplement: null });
    expect(sheet.anonymizedAt).toBeInstanceOf(Date);

    const [request] = await db.select().from(captureErasureRequests).where(eq(captureErasureRequests.id, requestId));
    expect(request).toMatchObject({ status: "completed", decidedByUserId: ids.admin, requestedByUserId: ids.finance, sheetsAnonymized: 1 });
    // A trilha não guarda dado pessoal: id, contagem e o pedido.
    const trail = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "capture"), eq(auditLogs.entityId, String(captureIds[0]))));
    expect(trail.map(row => row.action)).toEqual(expect.arrayContaining(["erasure_requested", "erasure_completed"]));
    expect(trail.map(row => row.summary).join(" ")).not.toMatch(/Casal Sintético|11911112222|exemplo\.test/);
    expect((await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "customer"), eq(auditLogs.entityId, String(customerId)), eq(auditLogs.action, "anonymized")))).length).toBe(1);

    // Ficha anonimizada: ainda abre (admin), não imprime, não recebe dado novo, não aceita novo pedido nem repetir o cumprimento.
    expect(await as("admin").captureSheet.byCode({ code: codes[0] })).toMatchObject({ customer: { fullName: `Casal Sintético fluxo ${runId}`, phone: null }, capture: { partnerName: null } });
    await expect(as("admin").captureSheet.recordPrint({ code: codes[0] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(as("admin").captureSheet.updateExtras({ captureId: captureIds[0], guest1Name: "Novo Nome" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(as("finance").captureSheet.erasure.request({ code: codes[0], reason: "de novo, pedido repetido" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await as("finance").captureSheet.erasure.forCode({ code: codes[0] })).requests[0]).toMatchObject({ id: requestId, status: "completed", sheetsAnonymized: 1 });
  });

  it("todas as fichas do mesmo cliente são anonimizadas juntas; a data do brinde sem voucher cai na criação da ficha mais antiga", async () => {
    const { customerId, captureIds, codes } = await seed("duas", 2);
    await db.delete(vouchers).where(eq(vouchers.customerId, customerId));
    const { requestId } = await as("admin").captureSheet.erasure.request({ code: codes[1], reason: "pedido do titular por e-mail" });
    const done = await as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[1] });
    expect(done.sheetsAnonymized).toBe(2);
    for (const id of captureIds) expect((await db.select().from(captureRecords).where(eq(captureRecords.id, id)))[0]).toMatchObject({ partnerName: null, anonymizedAt: expect.any(Date) });
    const created = (await db.select().from(captureRecords).where(eq(captureRecords.id, captureIds[0])))[0].createdAt;
    expect(Math.abs(done.giftDate.getTime() - created.getTime())).toBeLessThan(2000);
  });

  it("guarda legal: cliente com contrato ou ficha VENDEU não é anonimizado por aqui (recusa já no pedido); nada muda", async () => {
    const withContract = await seed("contrato");
    await db.insert(contracts).values({ number: `ERA-C-${runId}`, customerId: withContract.customerId, status: "draft", totalAmount: "1000.00" } as never);
    await expect(as("admin").captureSheet.erasure.request({ code: withContract.codes[0], reason: "titular pediu pelo canal" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("tem contrato") });
    const sold = await seed("vendeu");
    await db.update(captureRecords).set({ commercialOutcome: "vendeu" }).where(eq(captureRecords.id, sold.captureIds[0]));
    await expect(as("admin").captureSheet.erasure.request({ code: sold.codes[0], reason: "titular pediu pelo canal" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("VENDEU") });
    expect((await db.select().from(customers).where(eq(customers.id, withContract.customerId)))[0]).toMatchObject({ phone: "11911112222", anonymizedAt: null });
    // Contrato que apareceu depois do pedido também barra o cumprimento.
    const late = await seed("tarde");
    const { requestId } = await as("admin").captureSheet.erasure.request({ code: late.codes[0], reason: "titular pediu pelo canal" });
    await db.insert(contracts).values({ number: `ERA-T-${runId}`, customerId: late.customerId, status: "draft", totalAmount: "1000.00" } as never);
    await expect(as("admin").captureSheet.erasure.complete({ requestId, confirmCode: late.codes[0] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db.select().from(customers).where(eq(customers.id, late.customerId)))[0]).toMatchObject({ phone: "11911112222", anonymizedAt: null });
  });

  it("recusa com justificativa não apaga nada e libera um pedido novo", async () => {
    const { customerId, codes } = await seed("recusa");
    const { requestId } = await as("finance").captureSheet.erasure.request({ code: codes[0], reason: "alguém ligou dizendo ser o titular" });
    await expect(as("finance").captureSheet.erasure.reject({ requestId, note: "não confirmamos a identidade" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("admin").captureSheet.erasure.reject({ requestId, note: "abc" })).rejects.toBeDefined();
    await as("admin").captureSheet.erasure.reject({ requestId, note: "não confirmamos a identidade do solicitante" });
    expect((await db.select().from(customers).where(eq(customers.id, customerId)))[0]).toMatchObject({ phone: "11911112222", anonymizedAt: null });
    expect((await db.select().from(captureErasureRequests).where(eq(captureErasureRequests.id, requestId)))[0]).toMatchObject({ status: "rejected", decisionNote: "não confirmamos a identidade do solicitante" });
    await expect(as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(as("finance").captureSheet.erasure.request({ code: codes[0], reason: "titular confirmou a identidade" })).resolves.toMatchObject({ requestId: expect.any(Number) });
  });

  it("falha no meio do cumprimento (trilha do cliente recusada pelo banco) desfaz TUDO: o pedido segue aberto e nenhum dado foi tocado", async () => {
    const { customerId, captureIds, codes } = await seed("atomico");
    const { requestId } = await as("admin").captureSheet.erasure.request({ code: codes[0], reason: "titular pediu pelo canal" });
    const name = `era_fail_${runId}`;
    await runTriggerDdl(pool, `CREATE TRIGGER \`${name}\` BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.action = 'anonymized' AND NEW.entityId = '${customerId}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'falha injetada'; END IF; END`);
    triggers.push(name);
    await expect(as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] })).rejects.toBeDefined();
    expect((await db.select().from(customers).where(eq(customers.id, customerId)))[0]).toMatchObject({ phone: "11911112222", email: "atomico@exemplo.test", anonymizedAt: null });
    expect((await db.select().from(captureRecords).where(eq(captureRecords.id, captureIds[0])))[0]).toMatchObject({ partnerName: "Cônjuge Sintético", anonymizedAt: null });
    expect(await db.select().from(customerContacts).where(eq(customerContacts.customerId, customerId))).toHaveLength(2);
    expect((await db.select().from(captureErasureRequests).where(eq(captureErasureRequests.id, requestId)))[0]).toMatchObject({ status: "requested" });
    await runTriggerDdl(pool, `DROP TRIGGER IF EXISTS \`${name}\``);
    triggers.splice(0);
    await expect(as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] })).resolves.toMatchObject({ sheetsAnonymized: 1 });
  });

  it("cópias secundárias: snapshot de importação CSV, payload de eventos e motivo de voucher na trilha são higienizados na mesma transação (P1)", async () => {
    const digits = `9${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 20);
    const { customerId, captureIds, codes } = await seed("copias", 1, digits);
    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.customerId, customerId));
    // Importação que ATUALIZA o cliente existente grava a linha inteira antiga em beforeSnapshot.
    const csv = `nome_completo,documento,email,telefone\nCasal Sintético copias ${runId},${digits},novo-${runId}@exemplo.test,11955556666\n`;
    const committed = await as("admin").imports.commit({ kind: "customers", csv });
    expect(committed).toMatchObject({ committed: true, updated: 1 });
    const [item] = await db.select().from(csvImportItems).where(and(eq(csvImportItems.entityType, "customer"), eq(csvImportItems.entityId, customerId)));
    expect(item!.beforeSnapshot).toContain("exemplo.test");
    await db.insert(domainEvents).values([
      { eventName: "customer.updated", aggregateType: "customer", aggregateId: String(customerId), payload: JSON.stringify({ status: "active", city: "Natal", state: "RN" }) },
      { eventName: "capture.no_tour", aggregateType: "capture", aggregateId: String(captureIds[0]), payload: JSON.stringify({ salesRoom: "Sala", reason: "esposa doente" }) },
    ]);
    await db.insert(auditLogs).values({ entityType: "voucher", entityId: String(voucher!.id), action: "cancelled", summary: `Voucher ${voucher!.code} cancelado: viagem do marido.` });

    const { requestId } = await as("finance").captureSheet.erasure.request({ code: codes[0], reason: "titular pediu pelo canal" });
    await as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] });

    expect((await db.select().from(csvImportItems).where(eq(csvImportItems.id, item!.id)))[0]!.beforeSnapshot).toBeNull();
    const events = await db.select().from(domainEvents).where(and(eq(domainEvents.aggregateType, "customer"), eq(domainEvents.aggregateId, String(customerId))));
    expect(events.map(event => event.payload).join("")).not.toMatch(/Natal|RN|city/);
    expect(events.find(event => event.eventName === "customer.updated")!.payload).toBe(JSON.stringify({ status: "active" }));
    const captureEvents = await db.select().from(domainEvents).where(and(eq(domainEvents.aggregateType, "capture"), eq(domainEvents.aggregateId, String(captureIds[0]))));
    expect(captureEvents.map(event => event.payload).join("")).not.toContain("esposa doente");
    const [voucherAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "voucher"), eq(auditLogs.entityId, String(voucher!.id))));
    expect(voucherAudit!.summary).toBe(`Voucher ${voucher!.code} cancelado.`);
  });

  it("guarda central: depois de anonimizado, cadastro, contatos, interação, documento, captação e importação CSV NÃO desfazem a anonimização (P1)", async () => {
    const digits = `8${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 20);
    const { customerId, codes } = await seed("guarda", 1, digits);
    const { requestId } = await as("finance").captureSheet.erasure.request({ code: codes[0], reason: "titular pediu pelo canal" });
    await as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] });
    const refused = { code: "PRECONDITION_FAILED" };

    await expect(as("admin").customers.update({ id: customerId, data: { fullName: `Casal Sintético guarda ${runId}`, documentNumber: digits, email: "volta@exemplo.test", phone: "11900000000", status: "active" } as never })).rejects.toMatchObject(refused);
    await expect(as("admin").customerContacts.add({ customerId, kind: "phone", value: "11977778888" } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").customers.addInteraction({ customerId, type: "note", content: "nova anotação com dado" })).rejects.toMatchObject(refused);
    await expect(as("admin").customers.uploadDocument({ customerId, category: "RG", filename: "rg.pdf", contentType: "application/pdf", base64: Buffer.from("%PDF-1.4 sintetico sintetico").toString("base64") })).rejects.toMatchObject(refused);
    await expect(as("admin").captures.create({ customerId, salesRoom: `Sala ${runId}` } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").captures.create({ customer: { fullName: "Qualquer Nome", documentNumber: digits } } as never)).rejects.toMatchObject(refused);

    // CSV que casa o CPF retido é recusado na validação, sem tocar o cadastro.
    const csv = `nome_completo,documento,email,telefone\nCasal Sintético guarda ${runId},${digits},volta-${runId}@exemplo.test,11911119999\n`;
    const result = await as("admin").imports.commit({ kind: "customers", csv });
    expect(result).toMatchObject({ valid: false, committed: false });
    expect(result.issues[0]).toMatchObject({ field: "documentNumber" });

    const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
    expect(customer).toMatchObject({ email: null, phone: null, birthDate: null, city: null, status: "inactive" });
    expect(customer!.anonymizedAt).not.toBeNull();
    expect(await db.select().from(customerContacts).where(eq(customerContacts.customerId, customerId))).toHaveLength(0);
    expect((await db.select().from(customerInteractions).where(eq(customerInteractions.customerId, customerId)))[0]!.content).toBe("[removido a pedido do titular]");
  });

  it("ficha e cliente anonimizados não aceitam mais texto livre: mutações de captação, tarefa, oportunidade e voucher recusam (revisão formal)", async () => {
    const { customerId, captureIds, codes } = await seed("revisao");
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.customerId, customerId));
    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.customerId, customerId));
    const { requestId } = await as("finance").captureSheet.erasure.request({ code: codes[0], reason: "titular pediu pelo canal" });
    await as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] });
    const refused = { code: "PRECONDITION_FAILED" };
    const id = captureIds[0]!;

    await expect(as("admin").captures.updateStatus({ id, presentationStatus: "scheduled", qualificationReason: "texto livre novo" } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").captures.checkIn({ id, receptionNotes: "nota nova com dado" } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").captures.recordCommercialOutcome({ id, outcome: "caiu_em_mesa", reason: "motivo livre novo" } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").captures.markNoTour({ id, reason: "motivo livre novo" } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").captureSheet.recordNt({ captureId: id, kind: "perfil", motiveId: 1, complement: "complemento novo" } as never)).rejects.toMatchObject(refused);
    const [sheet] = await db.select().from(captureRecords).where(eq(captureRecords.id, id));
    expect(sheet).toMatchObject({ receptionNotes: null, qualificationReason: null, noTourReason: null, commercialOutcomeReason: null, ntComplement: null });

    await expect(as("admin").operations.createTask({ title: "Ligar para o cliente", description: "dado novo", customerId } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").sales.createOpportunity({ customerId, title: "Nova oportunidade", expectedAmount: 1000 } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").sales.updateOpportunity({ id: opp!.id, data: { customerId, title: "Título livre novo", stage: "new", expectedAmount: 1000 } } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").vouchers.issue({ customerId, description: "Outro brinde", requestId: randomUUID() } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").vouchers.redeem({ code: voucher!.code, note: "nota nova com dado" } as never)).rejects.toMatchObject(refused);
    await expect(as("admin").vouchers.cancel({ id: voucher!.id, reason: "motivo livre novo" } as never)).rejects.toMatchObject(refused);
    expect((await db.select().from(opportunities).where(eq(opportunities.id, opp!.id)))[0]!.title).toBe("Oportunidade anonimizada");
    expect((await db.select().from(vouchers).where(eq(vouchers.id, voucher!.id)))[0]).toMatchObject({ status: "issued", redeemNote: null, cancelReason: null });
  });

  it("eventos: lista de permissão também cobre oportunidade e interação (chaves novas ou de texto livre somem)", async () => {
    const { customerId, codes } = await seed("eventos");
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.customerId, customerId));
    const [interaction] = await db.select().from(customerInteractions).where(eq(customerInteractions.customerId, customerId));
    await db.insert(domainEvents).values([
      { eventName: "opportunity.updated", aggregateType: "opportunity", aggregateId: String(opp!.id), payload: JSON.stringify({ stage: "new", title: "Fulano quer vender", lossReason: "esposa", sellerId: 7 }) },
      { eventName: "customer.interaction.created", aggregateType: "customer_interaction", aggregateId: String(interaction!.id), payload: JSON.stringify({ customerId, type: "note", content: "conversa íntima", futureKey: "x" }) },
    ]);
    const { requestId } = await as("finance").captureSheet.erasure.request({ code: codes[0], reason: "titular pediu pelo canal" });
    await as("admin").captureSheet.erasure.complete({ requestId, confirmCode: codes[0] });
    const [oppEvent] = await db.select().from(domainEvents).where(and(eq(domainEvents.aggregateType, "opportunity"), eq(domainEvents.aggregateId, String(opp!.id))));
    expect(JSON.parse(oppEvent!.payload!)).toEqual({ stage: "new", sellerId: 7 });
    const [interactionEvent] = await db.select().from(domainEvents).where(and(eq(domainEvents.aggregateType, "customer_interaction"), eq(domainEvents.aggregateId, String(interaction!.id))));
    expect(JSON.parse(interactionEvent!.payload!)).toEqual({ customerId, type: "note" });
  });

  it("um pedido aberto por CLIENTE: ficha irmã do mesmo cliente não abre segundo pedido, nem em paralelo (P2)", async () => {
    const { codes } = await seed("irma", 2);
    const results = await Promise.allSettled([
      as("finance").captureSheet.erasure.request({ code: codes[0], reason: "titular pediu pelo canal" }),
      as("finance").captureSheet.erasure.request({ code: codes[1], reason: "titular pediu pelo canal" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")[0]).toMatchObject({ reason: { code: "PRECONDITION_FAILED" } });
    await expect(as("finance").captureSheet.erasure.request({ code: codes[1], reason: "titular pediu de novo" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("a migration 0066 semeou a chave do encarregado e o aviso v4 mostra a marcação enquanto faltar dado", async () => {
    const settings = await as("admin").captureSheet.settings.get();
    expect(settings.privacyNoticeStatus).toMatchObject({ version: "v4" });
    expect(Object.keys(settings.privacy)).toContain("privacy_dpo_name");
    const { codes } = await seed("aviso");
    const sheet = await as("admin").captureSheet.byCode({ code: codes[0] });
    expect(sheet.privacyNotice.startsWith("[PREENCHER ANTES DE CASAL REAL]")).toBe(settings.privacyNoticeStatus.complete ? false : true);
  });
});
