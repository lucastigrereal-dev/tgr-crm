import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, captureSheetPrints, captureSheetSettings, customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// LGPD da ficha em MySQL real (parecer 17/10, decisões do Lucas 16:14Z): custódia do papel, ficha de não comprador fora da
// vista da sala (só admin/finance), exportação com CPF só com export.pii e trilha com número de linhas. Dados sintéticos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("LGPD da ficha em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let userId: number;
  let todayId: number;
  let oldId: number;
  let soldId: number;
  const todayCode = `LGPD-HOJE-${runId}`, oldCode = `LGPD-ONTEM-${runId}`, soldCode = `LGPD-VENDEU-${runId}`;
  const room = `Sala LGPD ${runId}`;
  const previousEnv = { ...process.env };
  const caller = (role = "admin") => appRouter.createCaller({ user: { id: userId, role, name: "Teste LGPD" } } as never);
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `lgpd-${runId}`, name: "Teste LGPD", role: "admin" }).$returningId();
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal LGPD ${runId}`, documentNumber: `DOC-${runId}`, phone: "11988887777", city: "Natal", state: "RN", status: "active" }).$returningId();
    // Hoje (visível), visita de 3 dias atrás sem compra (arquivada) e visita de 3 dias atrás com VENDEU (continua visível).
    // O dia da visita é o check-in; createdAt fica no futuro próximo só para as três ficarem no topo da lista (limite de 120 linhas) num banco cheio de outras suítes.
    const pin = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    [{ id: todayId }] = await db.insert(captureRecords).values({ customerId, salesRoom: room, coupleCode: todayCode, checkedInAt: new Date(Date.now() - 60_000), createdAt: pin(3) }).$returningId();
    [{ id: oldId }] = await db.insert(captureRecords).values({ customerId, salesRoom: room, coupleCode: oldCode, checkedInAt: daysAgo(3), createdAt: pin(2), commercialOutcome: "caiu_em_mesa" }).$returningId();
    [{ id: soldId }] = await db.insert(captureRecords).values({ customerId, salesRoom: room, coupleCode: soldCode, checkedInAt: daysAgo(3), createdAt: pin(1), commercialOutcome: "vendeu" }).$returningId();
    await db.insert(captureSheetSettings).values({ key: "room_visibility_days", value: "0", provisional: true }).onDuplicateKeyUpdate({ set: { value: "0" } });
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  it("a migration 0063 semeou as chaves novas e elas saem em settings.get", async () => {
    // As 7 linhas existem de verdade (o fallback do código devolveria o mesmo valor sem a migration) e nascem provisórias.
    const keys = ["paper_destroy_deadline_days", "privacy_controller_name", "privacy_controller_cnpj", "privacy_contact_channel", "privacy_full_text_url", "privacy_retention_text", "room_visibility_days"];
    const seeded = await db.select().from(captureSheetSettings).where(inArray(captureSheetSettings.key, keys));
    expect(seeded.map(row => row.key).sort()).toEqual([...keys].sort());
    expect(seeded.every(row => row.provisional)).toBe(true);
    const settings = await caller().captureSheet.settings.get();
    expect(settings).toMatchObject({ roomVisibilityDays: 0, paperDestroyDeadlineDays: 0, privacy: { privacy_controller_name: "" } });
    await expect(caller().captureSheet.settings.set({ key: "room_visibility_days", value: "9999" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller().captureSheet.settings.set({ key: "privacy_controller_name", value: "Operadora Sintética Ltda" });
    expect((await caller().captureSheet.byCode({ code: todayCode })).privacyNotice).toContain("Operadora Sintética Ltda");
    await caller().captureSheet.settings.set({ key: "privacy_controller_name", value: "" });
  });

  it("ficha de hoje: sala abre; ficha antiga sem compra: seller e service levam FORBIDDEN sem gerar trilha, admin e finance abrem", async () => {
    expect((await caller("seller").captureSheet.byCode({ code: todayCode })).roomVisibility).toMatchObject({ visibleToRoom: true, reason: "dia_da_visita" });
    const before = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, String(oldId)), eq(auditLogs.action, "sheet_opened")));
    await expect(caller("seller").captureSheet.byCode({ code: oldCode })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("service").captureSheet.byCode({ code: oldCode })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("seller").captureSheet.recordPrint({ code: oldCode })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const after = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, String(oldId)), eq(auditLogs.action, "sheet_opened")));
    expect(after.length).toBe(before.length);
    expect((await caller("finance").captureSheet.byCode({ code: oldCode })).roomVisibility).toMatchObject({ visibleToRoom: false, reason: "arquivada" });
    expect((await caller("admin").captureSheet.byCode({ code: oldCode })).customer.documentNumber).toBe(`DOC-${runId}`);
    // VENDEU de 3 dias atrás continua na vista da sala.
    expect((await caller("seller").captureSheet.byCode({ code: soldCode })).roomVisibility).toMatchObject({ visibleToRoom: true, reason: "vendeu" });
    // Com 5 dias extras configurados, a antiga volta a aparecer para a sala.
    await caller().captureSheet.settings.set({ key: "room_visibility_days", value: "5" });
    expect((await caller("seller").captureSheet.byCode({ code: oldCode })).roomVisibility.visibleToRoom).toBe(true);
    await caller().captureSheet.settings.set({ key: "room_visibility_days", value: "0" });
  });

  it("a lista de captação segue a mesma vista: seller não vê a antiga sem compra, admin vê", async () => {
    const sellerIds = (await caller("seller").captures.list()).rows.map(row => row.capture.id);
    expect(sellerIds).toContain(todayId);
    expect(sellerIds).toContain(soldId);
    expect(sellerIds).not.toContain(oldId);
    const adminIds = (await caller("admin").captures.list()).rows.map(row => row.capture.id);
    expect(adminIds).toEqual(expect.arrayContaining([todayId, oldId, soldId]));
  });

  it("a ficha arquivada não vaza por outros caminhos: análise de perfil, fila da recepção, detalhe do cliente e painel do papel", async () => {
    const mentions = (value: unknown, code: string) => JSON.stringify(value).includes(code);
    const customerId = (await db.select({ id: captureRecords.customerId }).from(captureRecords).where(eq(captureRecords.id, oldId)))[0].id;
    const profileIds = async (role: string) => ((await caller(role).captures.profileAnalysis({ salesRoom: room } as never)).rows as Array<{ id: number }>).map(row => row.id);
    for (const role of ["seller", "service"]) {
      const ids = await profileIds(role);
      expect(ids).not.toContain(oldId);
      expect(ids).toContain(todayId);
    }
    expect(await profileIds("admin")).toContain(oldId);
    expect(await profileIds("finance")).toContain(oldId);
    for (const role of ["seller", "service"] as const) {
      const queue = await caller(role).captures.receptionQueue({ includeCompleted: true } as never);
      expect(mentions(queue, oldCode)).toBe(false);
    }
    const sellerDetail = await caller("seller").customers.detail({ id: customerId });
    expect(mentions(sellerDetail?.captures ?? sellerDetail, oldCode)).toBe(false);
    expect(mentions(sellerDetail?.captures ?? sellerDetail, soldCode)).toBe(true);
    expect(mentions((await caller("admin").customers.detail({ id: customerId }))?.captures, oldCode)).toBe(true);
    // Papel da ficha arquivada continua na lista de pendências, mas o nome do casal não aparece para a sala.
    await caller("admin").captureSheet.recordPrint({ code: oldCode });
    const room_ = (await caller("service").captureSheet.paper.outstanding()) as { sheets: Array<{ coupleCode: string | null; customerName: string | null }> };
    const line = room_.sheets.find(sheet => sheet.coupleCode === oldCode);
    expect(line?.customerName ?? null).toBeNull();
    const adminLine = ((await caller("admin").captureSheet.paper.outstanding()) as typeof room_).sheets.find(sheet => sheet.coupleCode === oldCode);
    expect(adminLine?.customerName).toContain("Casal LGPD");
    await db.delete(captureSheetPrints).where(eq(captureSheetPrints.captureId, oldId));
  });

  it("agendada para hoje e sem check-in continua na vista da sala; agendada para 3 dias atrás e faltou fica arquivada", async () => {
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Agenda ${runId}`, documentNumber: `AG-${runId}`, phone: "11977776666", city: "Natal", state: "RN", status: "active" }).$returningId();
    const pin = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    const codeToday = `LGPD-AGENDA-HOJE-${runId}`, codeMissed = `LGPD-AGENDA-FALTOU-${runId}`;
    // Ficha criada há 3 dias (createdAt antigo), agendada para hoje, sem check-in: a recepção precisa achar o casal.
    const [{ id: scheduledTodayId }] = await db.insert(captureRecords).values({ customerId, salesRoom: `Agenda ${runId}`, coupleCode: codeToday, scheduledAt: new Date(Date.now() + 30 * 60_000), createdAt: pin(4) }).$returningId();
    await db.update(captureRecords).set({ createdAt: daysAgo(3) }).where(eq(captureRecords.id, scheduledTodayId));
    await db.update(captureRecords).set({ createdAt: pin(4) }).where(eq(captureRecords.id, scheduledTodayId));
    const [{ id: missedId }] = await db.insert(captureRecords).values({ customerId, salesRoom: `Agenda ${runId}`, coupleCode: codeMissed, scheduledAt: daysAgo(3), createdAt: pin(5) }).$returningId();
    expect((await caller("seller").captureSheet.byCode({ code: codeToday })).roomVisibility).toMatchObject({ visibleToRoom: true });
    await expect(caller("seller").captureSheet.byCode({ code: codeMissed })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const listIds = (await caller("seller").captures.list()).rows.map(row => row.capture.id);
    expect(listIds).toContain(scheduledTodayId);
    expect(listIds).not.toContain(missedId);
  });

  it("reimpressão em outro dia mantém o alerta no painel mesmo com a cópia antiga já destruída", async () => {
    await db.insert(captureSheetPrints).values({ captureId: todayId, printedByUserId: userId, printedAt: daysAgo(3), destroyedAt: daysAgo(3), destroyedByUserId: userId, reprint: false });
    await db.insert(captureSheetPrints).values({ captureId: todayId, printedByUserId: userId, reprint: true });
    const panel = (await caller("service").captureSheet.paper.outstanding()) as { sheets: Array<{ coupleCode: string | null; reprintAlert: boolean }> };
    const line = panel.sheets.find(sheet => sheet.coupleCode === todayCode) as { reprintAlert: boolean; printCount: number } | undefined;
    expect(line?.reprintAlert).toBe(true);
    expect(line?.printCount).toBe(2);
    await db.delete(captureSheetPrints).where(eq(captureSheetPrints.captureId, todayId));
  });

  it("ficha arquivada não aceita escrita da sala (extras e equipe) nem aparece no painel do dia; a linha do painel tem as ações do papel", async () => {
    const name = `Casal Painel ${runId}`;
    const [{ id: panelCustomerId }] = await db.insert(customers).values({ fullName: name, documentNumber: `PN-${runId}`, phone: "11966665555", city: "Natal", state: "RN", status: "active" }).$returningId();
    const [{ id: archivedId }] = await db.insert(captureRecords).values({ customerId: panelCustomerId, salesRoom: `Painel ${runId}`, coupleCode: `LGPD-PAINEL-${runId}`, checkedInAt: daysAgo(3), createdAt: daysAgo(3) }).$returningId();
    await expect(caller("seller").captureSheet.updateExtras({ captureId: archivedId, pepOffered: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("seller").captureSheet.team.set({ captureId: archivedId, roleId: 1, personName: "Pessoa Teste" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("seller").captureSheet.team.clear({ captureId: archivedId, roleId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("seller").captureSheet.setCoupleCode({ captureId: archivedId, coupleCode: `LGPD-TROCA-${runId}` })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await caller("seller").captureSheet.today()).today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await db.select({ pepOffered: captureRecords.pepOffered }).from(captureRecords).where(eq(captureRecords.id, archivedId)))[0].pepOffered).toBeFalsy();
    // Admin segue podendo corrigir a ficha arquivada.
    expect(await caller("admin").captureSheet.updateExtras({ captureId: archivedId, pepOffered: true })).toMatchObject({ updated: true });
    const pulse = await caller("seller").dashboard.operationalPulse();
    expect(JSON.stringify(pulse).includes(name)).toBe(false);
    expect(JSON.stringify(await caller("admin").dashboard.operationalPulse()).includes(name)).toBe(true);
  });

  it("custódia do papel: imprime, recolhe, destrói, com trilha; o painel do dia conta e o alerta de reimpressão dispara", async () => {
    await expect(caller("service").captureSheet.paper.collect({ code: todayCode })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller("service").captureSheet.recordPrint({ code: todayCode });
    let sheet = await caller().captureSheet.byCode({ code: todayCode });
    expect(sheet.paper).toMatchObject({ status: "em_circulacao", overdue: false, reprintAlert: false });
    expect(await caller("service").captureSheet.paper.collect({ code: todayCode })).toEqual({ collected: 1 });
    await expect(caller("service").captureSheet.paper.collect({ code: todayCode })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    sheet = await caller().captureSheet.byCode({ code: todayCode });
    expect(sheet.paper.status).toBe("recolhida");
    // Reimpressão: a nova cópia entra em circulação e o alerta liga.
    await caller("service").captureSheet.recordPrint({ code: todayCode });
    sheet = await caller().captureSheet.byCode({ code: todayCode });
    expect(sheet.paper).toMatchObject({ status: "em_circulacao", reprintAlert: true });
    const panel = await caller("service").captureSheet.paper.outstanding();
    const mine = panel.sheets.find(row => row.captureId === todayId);
    expect(mine).toMatchObject({ coupleCode: todayCode, printCount: 2, status: "em_circulacao", reprintAlert: true });
    expect(panel.notCollected).toBeGreaterThanOrEqual(1);
    // Destruir sem recolher a segunda cópia: recolhimento marcado junto, todas as impressões fechadas.
    expect(await caller("service").captureSheet.paper.destroy({ code: todayCode })).toEqual({ destroyed: 2 });
    const prints = await db.select().from(captureSheetPrints).where(eq(captureSheetPrints.captureId, todayId));
    expect(prints.every(row => row.destroyedAt && row.collectedAt && row.destroyedByUserId === userId)).toBe(true);
    sheet = await caller().captureSheet.byCode({ code: todayCode });
    expect(sheet.paper.status).toBe("destruida");
    expect((await caller("service").captureSheet.paper.outstanding()).sheets.find(row => row.captureId === todayId)?.status).toBe("destruida");
    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, String(todayId)))).map(row => row.action);
    expect(actions).toEqual(expect.arrayContaining(["sheet_paper_collected", "sheet_paper_destroyed"]));
    // Papel recolhido/destruído vale mesmo na ficha fora da vista da sala (não devolve dado pessoal).
    await caller("admin").captureSheet.recordPrint({ code: oldCode });
    expect(await caller("service").captureSheet.paper.destroy({ code: oldCode })).toEqual({ destroyed: 1 });
    // A ficha digital continua inteira depois de destruir o papel.
    expect((await db.select().from(captureRecords).where(eq(captureRecords.id, todayId))).length).toBe(1);
  });

  it("exportação: CPF só com export.pii; seller não leva fichas arquivadas; trilha guarda formato, filtros e número de linhas sem dado pessoal", async () => {
    const from = daysAgo(10).toISOString().slice(0, 10), to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await expect(caller("seller").captureSheet.export.rows({ from, to, salesRoom: room, withCpf: true, format: "csv" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("service").captureSheet.export.rows({ from, to, salesRoom: room, withCpf: true, format: "csv" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("admin").captureSheet.export.rows({ from: to, to: from, withCpf: false, format: "csv" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const seller = await caller("seller").captureSheet.export.rows({ from, to, salesRoom: room, withCpf: false, format: "csv" });
    expect(seller.rows.map(row => row.captureId).sort()).toEqual([todayId, soldId].sort());
    expect(seller.rows.every(row => row.documentNumber === null)).toBe(true);
    const admin = await caller("admin").captureSheet.export.rows({ from, to, salesRoom: room, withCpf: false, format: "xlsx" });
    expect(admin.rows.map(row => row.captureId).sort()).toEqual([todayId, oldId, soldId].sort());
    expect(admin.rows.every(row => row.documentNumber === null)).toBe(true);
    const finance = await caller("finance").captureSheet.export.rows({ from, to, salesRoom: room, withCpf: true, format: "csv" });
    expect(finance.rows).toHaveLength(3);
    expect(finance.rows[0]!.documentNumber).toBe(`DOC-${runId}`);
    const trail = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "sheet_exported"), like(auditLogs.summary, `%${room}%`)));
    expect(trail.length).toBe(3);
    expect(trail.map(row => row.summary)).toEqual(expect.arrayContaining([expect.stringContaining("CSV: 2 linha(s)"), expect.stringContaining("XLSX: 3 linha(s)"), expect.stringContaining("COM CPF")]));
    expect(trail.every(row => !new RegExp(`DOC-${runId}|11988887777`).test(row.summary ?? ""))).toBe(true);
  });

  it("o prazo prometido fica gravado na impressão: mudar a configuração depois não reescreve o papel já impresso", async () => {
    await caller().captureSheet.settings.set({ key: "paper_destroy_deadline_days", value: "2" });
    await caller("service").captureSheet.recordPrint({ code: soldCode });
    await caller().captureSheet.settings.set({ key: "paper_destroy_deadline_days", value: "0" });
    try {
      const sheet = await caller("seller").captureSheet.byCode({ code: soldCode });
      expect(sheet.paper.destroyDeadlineDays).toBe(2);
      expect(sheet.paper.overdue).toBe(false);
      const [print] = await db.select().from(captureSheetPrints).where(eq(captureSheetPrints.captureId, soldId));
      expect(print!.destroyDeadlineDays).toBe(2);
    } finally {
      await db.delete(captureSheetPrints).where(eq(captureSheetPrints.captureId, soldId));
    }
  });

  it("mutações da sala por id recusam ficha arquivada para seller e service; admin segue", async () => {
    const [before] = await db.select({ checkedInAt: captureRecords.checkedInAt, presentationStatus: captureRecords.presentationStatus }).from(captureRecords).where(eq(captureRecords.id, oldId));
    await expect(caller("service").captures.checkIn({ id: oldId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("seller").captures.updateStatus({ id: oldId, presentationStatus: "checked_in" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("seller").captures.assignRoom({ id: oldId, salesTable: "M-01" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("service").captures.markNoTour({ id: oldId, reason: "Teste sintético" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [after] = await db.select({ checkedInAt: captureRecords.checkedInAt, presentationStatus: captureRecords.presentationStatus }).from(captureRecords).where(eq(captureRecords.id, oldId));
    expect(after).toEqual(before);
    expect((await caller("seller").captureSheet.byCode({ code: oldCode }).catch(error => error)).code).toBe("FORBIDDEN");
  });

  it("opções de ficha do brinde e emissão seguem a vista da sala", async () => {
    const [{ customerId }] = await db.select({ customerId: captureRecords.customerId }).from(captureRecords).where(eq(captureRecords.id, oldId));
    const sellerIds = (await caller("seller").vouchers.captureOptions({ customerId })).captures.map(row => row.id);
    expect(sellerIds).toEqual(expect.arrayContaining([todayId, soldId]));
    expect(sellerIds).not.toContain(oldId);
    expect((await caller("admin").vouchers.captureOptions({ customerId })).captures.map(row => row.id)).toContain(oldId);
    await expect(caller("service").vouchers.issue({ customerId, captureId: oldId, description: "Brinde sintético", costAmount: 0, requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Reenvio de emissão já gravada devolve o voucher mesmo com a ficha fora da vista (idempotência).
    const requestId = randomUUID();
    const first = await caller("admin").vouchers.issue({ customerId, captureId: oldId, description: "Brinde sintético", costAmount: 0, requestId });
    expect(await caller("service").vouchers.issue({ customerId, captureId: oldId, description: "Brinde sintético", costAmount: 0, requestId })).toEqual(first);
  });
});
