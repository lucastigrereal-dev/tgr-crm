import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureErasureRequests, captureRecords, contracts, customerContacts, customerInteractions, customers, opportunities, users, vouchers } from "../drizzle/schema";
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
  async function seed(label: string, sheets = 1) {
    const [{ id: customerId }] = await db.insert(customers).values({
      fullName: `Casal Sintético ${label} ${runId}`, documentNumber: `ERA${label}${runId}`.slice(0, 32), email: `${label}@exemplo.test`, phone: "11911112222", birthDate: new Date("1980-05-05T12:00:00Z"),
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

  it("a migration 0066 semeou a chave do encarregado e o aviso v4 mostra a marcação enquanto faltar dado", async () => {
    const settings = await as("admin").captureSheet.settings.get();
    expect(settings.privacyNoticeStatus).toMatchObject({ version: "v4" });
    expect(Object.keys(settings.privacy)).toContain("privacy_dpo_name");
    const { codes } = await seed("aviso");
    const sheet = await as("admin").captureSheet.byCode({ code: codes[0] });
    expect(sheet.privacyNotice.startsWith("[PREENCHER ANTES DE CASAL REAL]")).toBe(settings.privacyNoticeStatus.complete ? false : true);
  });
});
