import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, captureRecords, captureSheetPrints, captureTeamMembers, captureTeamRoles, customers, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Ficha impressa (TSE x CRM) em MySQL real: abre pelo código do casal, reimpressão auditada, equipe por papel, PEP e campos novos.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("ficha impressa e equipe por papel em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let userId: number;
  let captureId: number;
  let otherCaptureId: number;
  const code = `FICHA-${runId}`;
  const previousEnv = { ...process.env };
  const caller = (role = "admin") => appRouter.createCaller({ user: { id: userId, role } } as never);

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `sheet-${runId}`, name: "Recepção ficha", role: "admin" }).$returningId();
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Casal Ficha ${runId}`, phone: "11999990000", status: "active" }).$returningId();
    const now = new Date();
    [{ id: captureId }] = await db.insert(captureRecords).values({ customerId, salesRoom: `Sala ${runId}`, checkedInAt: new Date(now.getTime() - 60_000), relationshipYears: 3, relationshipMonths: 2 }).$returningId();
    [{ id: otherCaptureId }] = await db.insert(captureRecords).values({ customerId, salesRoom: `Sala ${runId}`, checkedInAt: new Date(now.getTime() - 120_000) }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  it("os papéis de equipe da migração já existem, com motorista e recepção como apoio", async () => {
    const roles = await caller().captureSheet.roles.list();
    const byCode = new Map(roles.map(role => [role.code, role]));
    expect(byCode.get("promotor_telemarketing")).toMatchObject({ kind: "presentation" });
    expect(byCode.get("motorista")).toMatchObject({ kind: "support" });
    expect(byCode.get("recepcao_2")).toMatchObject({ kind: "support" });
  });

  it("liga a ficha ao código do casal, recusa código repetido ou inválido e abre a ficha por ele", async () => {
    await expect(caller().captureSheet.setCoupleCode({ captureId, coupleCode: "12345678901" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller().captureSheet.setCoupleCode({ captureId, coupleCode: ` ${code} ` });
    await caller().captureSheet.setCoupleCode({ captureId, coupleCode: code });
    await expect(caller().captureSheet.setCoupleCode({ captureId: otherCaptureId, coupleCode: code })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller("seller").captureSheet.setCoupleCode({ captureId, coupleCode: `${code}-X` })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await caller().captureSheet.codeOf({ captureId })).toEqual({ coupleCode: code });
    const sheet = await caller().captureSheet.byCode({ code });
    expect(sheet).toMatchObject({ captureId, coupleCode: code, customer: { fullName: `Casal Ficha ${runId}` }, derived: { relationshipDays: 3 * 365 + 60 } });
    await expect(caller().captureSheet.byCode({ code: "NAO-EXISTE-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("user").captureSheet.byCode({ code })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ordem de chegada conta quem chegou antes na mesma sala e no mesmo dia", async () => {
    const sheet = await caller().captureSheet.byCode({ code });
    expect(sheet.derived.arrivalOrder).toBe(2);
  });

  it("impressão original e reimpressão ficam registradas e auditadas, com o mesmo QR", async () => {
    expect(await caller().captureSheet.recordPrint({ code })).toEqual({ reprint: false });
    expect(await caller().captureSheet.recordPrint({ code })).toEqual({ reprint: true });
    const prints = await db.select().from(captureSheetPrints).where(eq(captureSheetPrints.captureId, captureId));
    expect(prints.map(row => row.reprint).sort()).toEqual([false, true]);
    expect((await caller().captureSheet.byCode({ code })).printCount).toBe(2);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "capture"), eq(auditLogs.entityId, String(captureId))));
    expect(audits.map(row => row.action)).toEqual(expect.arrayContaining(["sheet_printed", "sheet_reprinted", "couple_code_set"]));
  });

  it("monta a equipe por papel, com login ou só o nome, e troca sem duplicar", async () => {
    const roles = await caller().captureSheet.roles.list();
    const driver = roles.find(role => role.code === "motorista")!;
    const tele = roles.find(role => role.code === "promotor_telemarketing")!;
    await expect(caller().captureSheet.team.set({ captureId, roleId: driver.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller().captureSheet.team.set({ captureId, roleId: driver.id, personName: "Zé Motorista" });
    await caller().captureSheet.team.set({ captureId, roleId: driver.id, personName: "João Motorista" });
    await caller().captureSheet.team.set({ captureId, roleId: tele.id, userId });
    const rows = await db.select().from(captureTeamMembers).where(eq(captureTeamMembers.captureId, captureId));
    expect(rows).toHaveLength(2);
    const members = (await caller().captureSheet.byCode({ code })).team.members;
    expect(members).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "motorista", name: "João Motorista", kind: "support" }),
      expect.objectContaining({ code: "promotor_telemarketing", name: "Recepção ficha" }),
    ]));
    await caller().captureSheet.team.clear({ captureId, roleId: driver.id });
    expect((await caller().captureSheet.byCode({ code })).team.members.map(member => member.code)).toEqual(["promotor_telemarketing"]);
  });

  it("papel novo e papel desativado: admin cria sem migration; papel desativado não aceita atribuição", async () => {
    const roleCode = `papel_${runId.slice(0, 6)}`;
    await expect(caller("seller").captureSheet.roles.upsert({ code: roleCode, label: "Papel teste", kind: "support", sortOrder: 900, active: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller().captureSheet.roles.upsert({ code: roleCode, label: "Papel teste", kind: "support", sortOrder: 900, active: true });
    await expect(caller().captureSheet.roles.upsert({ code: roleCode, label: "Repetido", kind: "support", sortOrder: 900, active: true })).rejects.toMatchObject({ code: "CONFLICT" });
    const [role] = await db.select().from(captureTeamRoles).where(eq(captureTeamRoles.code, roleCode));
    await caller().captureSheet.roles.upsert({ id: role.id, code: roleCode, label: "Papel teste", kind: "support", sortOrder: 900, active: false });
    await expect(caller().captureSheet.team.set({ captureId, roleId: role.id, personName: "Alguém" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("guarda segundo carro, aposentado, convidado e PEP; resultado de PEP exige oferta", async () => {
    await expect(caller().captureSheet.updateExtras({ captureId, pepResult: "accepted" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller().captureSheet.updateExtras({ captureId, secondVehicleModel: " Civic ", secondVehicleYear: 2019, retiredPrimary: true, retiredPartner: false, guest1Name: "Convidada Um", guest2Name: "  " });
    await expect(caller().captureSheet.updateExtras({ captureId, pepOffered: null as never })).rejects.toBeTruthy();
    await caller().captureSheet.updateExtras({ captureId, pepOffered: true, pepOfferedBy: "Fechador Teste" });
    await caller().captureSheet.updateExtras({ captureId, pepResult: "declined" });
    const { capture } = await caller().captureSheet.byCode({ code });
    expect(capture).toMatchObject({ secondVehicleModel: "Civic", secondVehicleYear: 2019, retiredPrimary: true, retiredPartner: false, guest1Name: "Convidada Um", guest2Name: null, pepOffered: true, pepOfferedBy: "Fechador Teste", pepResult: "declined" });
    await caller().captureSheet.updateExtras({ captureId, pepOffered: false });
    expect((await caller().captureSheet.byCode({ code })).capture).toMatchObject({ pepOffered: false, pepOfferedBy: null, pepResult: null });
  });
});
