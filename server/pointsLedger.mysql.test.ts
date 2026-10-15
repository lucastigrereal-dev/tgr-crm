import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { auditLogs, contracts, customers, ownershipEntitlements, pointsLedger, reservations, resorts, units, users } from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Extrato de pontos (TSE #29) em MySQL real: só inclusão, saldo nunca negativo, crédito anual uma vez, estorno uma vez.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);

describe.skipIf(!integrationUrl)("extrato de pontos em MySQL real", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let appRouter: typeof import("./routers")["appRouter"];
  let userId: number;
  let entitlementId: number;
  let weekEntitlementId: number;
  let reservationId: number;
  let otherReservationId: number;
  let contractIdForRace: number;
  let resortIdForRace: number;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    ({ appRouter } = await import("./routers"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 6 });
    db = drizzle({ client: pool });
    [{ id: userId }] = await db.insert(users).values({ openId: `points-${runId}`, name: "Atendimento pontos", role: "admin" }).$returningId();
    const [{ id: customerId }] = await db.insert(customers).values({ fullName: `Associado Pontos ${runId}`, status: "active" }).$returningId();
    const [{ id: contractId }] = await db.insert(contracts).values({ number: `PTS-${runId}`, customerId, status: "active", totalAmount: "10000.00" } as never).$returningId();
    const [{ id: otherContractId }] = await db.insert(contracts).values({ number: `PTS-OUTRO-${runId}`, customerId, status: "active", totalAmount: "10000.00" } as never).$returningId();
    const [{ id: resortId }] = await db.insert(resorts).values({ name: `Resort Pontos ${runId}` } as never).$returningId();
    const [{ id: unitId }] = await db.insert(units).values({ resortId, code: `P-${runId}` } as never).$returningId();
    contractIdForRace = contractId; resortIdForRace = resortId;
    [{ id: entitlementId }] = await db.insert(ownershipEntitlements).values({ contractId, resortId, entitlementType: "points", annualPoints: 1000, validFrom: new Date("2025-01-01T12:00:00Z"), validUntil: new Date("2035-12-31T12:00:00Z") }).$returningId();
    [{ id: weekEntitlementId }] = await db.insert(ownershipEntitlements).values({ contractId, resortId, entitlementType: "fixed_week", fixedWeek: 10 }).$returningId();
    [{ id: reservationId }] = await db.insert(reservations).values({ customerId, contractId, unitId, checkIn: new Date("2026-11-10T12:00:00Z"), checkOut: new Date("2026-11-14T12:00:00Z"), status: "confirmed" }).$returningId();
    [{ id: otherReservationId }] = await db.insert(reservations).values({ customerId, contractId: otherContractId, unitId, checkIn: new Date("2026-12-10T12:00:00Z"), checkOut: new Date("2026-12-12T12:00:00Z"), status: "confirmed" }).$returningId();
  });
  afterAll(async () => { process.env = previousEnv; await pool?.end(); });

  const caller = (role = "service") => appRouter.createCaller({ user: { id: userId, role } } as never);
  const balance = async () => (await caller().pointsLedger.statement({ entitlementId })).balance;

  it("credita o ano uma vez só, dentro da vigência, e só em direito por pontos", async () => {
    await caller().pointsLedger.creditAnnual({ entitlementId, year: 2026 });
    expect(await balance()).toBe(1000);
    await expect(caller().pointsLedger.creditAnnual({ entitlementId, year: 2026 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().pointsLedger.creditAnnual({ entitlementId, year: 2040 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().pointsLedger.creditAnnual({ entitlementId: weekEntitlementId, year: 2026 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const results = await Promise.allSettled([2025, 2025, 2025].map(year => caller().pointsLedger.creditAnnual({ entitlementId, year })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await balance()).toBe(2000);
    // Ano seguinte dentro da vigência ainda não se credita: os pontos ficariam usáveis antes da hora.
    // O extrato informa o ano corrente do projeto, o mesmo que limita o crédito.
    const { currentYear } = await caller().pointsLedger.statement({ entitlementId });
    expect(currentYear).toBeGreaterThanOrEqual(2026);
    const nextYear = currentYear + 1;
    await expect(caller().pointsLedger.creditAnnual({ entitlementId, year: nextYear })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await balance()).toBe(2000);
  });

  it("uso não passa do saldo, uma reserva consome uma vez, e reserva de outro contrato é recusada", async () => {
    await caller().pointsLedger.recordUsage({ entitlementId, points: 600, reservationId, note: "Semana de novembro", requestId: randomUUID() });
    expect(await balance()).toBe(1400);
    await expect(caller().pointsLedger.recordUsage({ entitlementId, points: 10, reservationId, requestId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().pointsLedger.recordUsage({ entitlementId, points: 10, reservationId: otherReservationId, requestId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().pointsLedger.recordUsage({ entitlementId, points: 1401, requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const results = await Promise.allSettled([800, 800].map(points => caller().pointsLedger.recordUsage({ entitlementId, points, requestId: randomUUID() })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await balance()).toBe(600);
  });

  it("estorno devolve uma vez, não se estorna estorno, libera a reserva para novo uso e ajuste é só do administrador", async () => {
    const statement = await caller().pointsLedger.statement({ entitlementId });
    const usage = statement.entries.find(entry => entry.entryType === "usage" && entry.reservationId === reservationId)!;
    await expect(caller("service").pointsLedger.reverse({ entryId: usage.id, note: "Reserva remarcada" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const reversal = await caller("admin").pointsLedger.reverse({ entryId: usage.id, note: "Reserva remarcada" });
    expect(await balance()).toBe(1200);
    await expect(caller("admin").pointsLedger.reverse({ entryId: usage.id, note: "De novo por engano" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller("admin").pointsLedger.reverse({ entryId: reversal.entryId, note: "Estorno do estorno" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller().pointsLedger.recordUsage({ entitlementId, points: 500, reservationId, requestId: randomUUID() });
    expect(await balance()).toBe(700);

    await expect(caller("service").pointsLedger.adjust({ entitlementId, points: 50, note: "Bônus de fidelidade", requestId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("admin").pointsLedger.adjust({ entitlementId, points: -701, note: "Correção maior que o saldo", requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller("admin").pointsLedger.adjust({ entitlementId, points: -200, note: "Correção de lançamento manual", requestId: randomUUID() });
    const final = await caller().pointsLedger.statement({ entitlementId });
    expect(final.balance).toBe(500);
    expect(final.entries[0]).toMatchObject({ entryType: "adjustment", points: -200, balanceAfter: 500 });
    expect(final.entries.find(entry => entry.id === usage.id)).toMatchObject({ reversed: true });
  });

  it("reenvio com o mesmo requestId devolve o mesmo lançamento e não debita de novo", async () => {
    const before = await balance();
    const requestId = randomUUID();
    const first = await caller().pointsLedger.recordUsage({ entitlementId, points: 50, requestId });
    const again = await caller().pointsLedger.recordUsage({ entitlementId, points: 50, requestId });
    expect(again.entryId).toBe(first.entryId);
    // Auditoria que falhou na primeira vez: o reenvio grava, e mais um reenvio não duplica.
    await db.delete(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${first.entryId}`));
    await caller().pointsLedger.recordUsage({ entitlementId, points: 50, requestId });
    await caller().pointsLedger.recordUsage({ entitlementId, points: 50, requestId });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${first.entryId}`))).toHaveLength(1);
    const adjustId = randomUUID();
    const adjusted = await caller("admin").pointsLedger.adjust({ entitlementId, points: 20, note: "Bônus de boas-vindas", requestId: adjustId });
    const results = await Promise.all([1, 2].map(() => caller("admin").pointsLedger.adjust({ entitlementId, points: 20, note: "Bônus de boas-vindas", requestId: adjustId })));
    expect(results.map(result => result.entryId)).toEqual([adjusted.entryId, adjusted.entryId]);
    expect(await balance()).toBe(before - 50 + 20);
  });

  it("reenvio com o mesmo requestId e outros dados é recusado, e a auditoria descreve o lançamento gravado", async () => {
    const before = await balance();
    const requestId = randomUUID();
    const first = await caller().pointsLedger.recordUsage({ entitlementId, points: 5, note: "Uso original", requestId });
    await db.delete(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${first.entryId}`));
    await expect(caller().pointsLedger.recordUsage({ entitlementId, points: 500, note: "Editado na tela", requestId })).rejects.toMatchObject({ code: "CONFLICT" });
    const [usageAudit] = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${first.entryId}`));
    expect(usageAudit?.summary).toContain("Uso de 5 ponto(s)");
    const adjustId = randomUUID();
    const adjusted = await caller("admin").pointsLedger.adjust({ entitlementId, points: 7, note: "Ajuste original", requestId: adjustId });
    await db.delete(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${adjusted.entryId}`));
    await expect(caller("admin").pointsLedger.adjust({ entitlementId, points: 70, note: "Ajuste editado", requestId: adjustId })).rejects.toMatchObject({ code: "CONFLICT" });
    const [adjustAudit] = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${adjusted.entryId}`));
    expect(adjustAudit?.summary).toContain("Ajuste de 7 ponto(s)");
    expect(adjustAudit?.summary).toContain("Ajuste original");
    expect(await balance()).toBe(before - 5 + 7);
  });

  it("estorno de crédito e uso ao mesmo tempo nunca deixam o saldo negativo", async () => {
    for (let round = 0; round < 10; round += 1) {
      const [{ id: racing }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 100, validFrom: new Date("2026-01-01T12:00:00Z"), validUntil: new Date("2035-12-31T12:00:00Z") }).$returningId();
      const credit = await caller().pointsLedger.creditAnnual({ entitlementId: racing, year: 2026 });
      const results = await Promise.allSettled([
        caller("admin").pointsLedger.reverse({ entryId: credit.entryId, note: "Crédito lançado por engano" }),
        caller().pointsLedger.recordUsage({ entitlementId: racing, points: 100, requestId: randomUUID() }),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect((await caller().pointsLedger.statement({ entitlementId: racing })).balance).toBe(0);
    }
  });

  it("extrato longo: saldo pela soma de todos os lançamentos e lista dos mais recentes avisando o corte", async () => {
    const [{ id: busy }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 0 }).$returningId();
    await db.insert(pointsLedger).values(Array.from({ length: 620 }, (_, index) => ({ entitlementId: busy, entryType: "adjustment" as const, points: 1, note: `Lote sintético ${index}`, createdByUserId: userId })));
    const statement = await caller().pointsLedger.statement({ entitlementId: busy });
    expect(statement.balance).toBe(620);
    expect(statement.totalEntries).toBe(620);
    expect(statement.truncated).toBe(true);
    expect(statement.entries).toHaveLength(500);
    expect(statement.entries[0]!.balanceAfter).toBe(620);
    expect(statement.entries.at(-1)!.balanceAfter).toBe(121);
    const older = await caller().pointsLedger.statement({ entitlementId: busy, beforeId: statement.nextBeforeId! });
    expect(older.entries).toHaveLength(120);
    expect(older.entries[0]!.balanceAfter).toBe(120);
    expect(older.entries.at(-1)!.balanceAfter).toBe(1);
    expect(older.nextBeforeId).toBeNull();
    expect(new Set([...statement.entries, ...older.entries].map(entry => entry.id)).size).toBe(620);
  });

  it("direito de uso cancelado não recebe ajuste", async () => {
    const [{ id: closed }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 100, status: "cancelled" }).$returningId();
    await expect(caller("admin").pointsLedger.adjust({ entitlementId: closed, points: 50, note: "Bônus depois do distrato", requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("uso e ajuste fora da vigência são recusados, mesmo com status ativo", async () => {
    const [{ id: lapsed }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 100, validFrom: new Date("2020-01-01T12:00:00Z"), validUntil: new Date("2021-12-31T12:00:00Z") }).$returningId();
    // Crédito de 2021 gravado direto: o sistema já não credita ano vencido.
    await db.insert(pointsLedger).values({ entitlementId: lapsed, entryType: "annual_credit", points: 100, referenceYear: 2021, idempotencyKey: `annual:${lapsed}:2021`, createdByUserId: userId });
    await expect(caller().pointsLedger.recordUsage({ entitlementId: lapsed, points: 10, requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("venceu") });
    await expect(caller("admin").pointsLedger.adjust({ entitlementId: lapsed, points: 10, note: "Bônus fora da vigência", requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [{ id: future }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 100, validFrom: new Date("2099-01-01T12:00:00Z") }).$returningId();
    await expect(caller().pointsLedger.recordUsage({ entitlementId: future, points: 1, requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("a partir") });
  });

  it("crédito do ano e estorno repetidos respondem CONFLICT e gravam a auditoria que tinha faltado", async () => {
    const [{ id: audited }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 100, validFrom: new Date("2026-01-01T12:00:00Z"), validUntil: new Date("2035-12-31T12:00:00Z") }).$returningId();
    const credit = await caller().pointsLedger.creditAnnual({ entitlementId: audited, year: 2026 });
    await db.delete(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${credit.entryId}`));
    // Outro operador reenvia: a auditoria volta com o autor do crédito gravado.
    const [{ id: otherUser }] = await db.insert(users).values({ openId: `points-other-${runId}`, name: "Outro atendimento", role: "service" }).$returningId();
    await expect(appRouter.createCaller({ user: { id: otherUser, role: "service" } } as never).pointsLedger.creditAnnual({ entitlementId: audited, year: 2026 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().pointsLedger.creditAnnual({ entitlementId: audited, year: 2026 })).rejects.toMatchObject({ code: "CONFLICT" });
    const creditAudits = await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${credit.entryId}`));
    expect(creditAudits.map(row => row.actorUserId)).toEqual([userId]);
    const reversal = await caller("admin").pointsLedger.reverse({ entryId: credit.entryId, note: "Crédito em duplicidade" });
    await db.delete(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${reversal.entryId}`));
    await expect(caller("admin").pointsLedger.reverse({ entryId: credit.entryId, note: "Crédito em duplicidade" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller("admin").pointsLedger.reverse({ entryId: credit.entryId, note: "Crédito em duplicidade" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${reversal.entryId}`))).toHaveLength(1);
  });

  it("reserva que consumiu pontos só cancela depois do estorno; uso e cancelamento ao mesmo tempo nunca deixam reserva cancelada com débito", async () => {
    const [{ id: booked }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 1000, validFrom: new Date("2026-01-01T12:00:00Z"), validUntil: new Date("2035-12-31T12:00:00Z") }).$returningId();
    await caller().pointsLedger.creditAnnual({ entitlementId: booked, year: 2026 });
    const [{ unitId }] = await db.select({ unitId: reservations.unitId }).from(reservations).where(eq(reservations.id, reservationId));
    const newReservation = async () => (await db.insert(reservations).values({ customerId: (await db.select({ customerId: reservations.customerId }).from(reservations).where(eq(reservations.id, reservationId)))[0]!.customerId, contractId: contractIdForRace, unitId, checkIn: new Date("2027-03-10T12:00:00Z"), checkOut: new Date("2027-03-12T12:00:00Z"), status: "confirmed" }).$returningId())[0]!.id;
    const ops = () => appRouter.createCaller({ user: { id: userId, role: "service" } } as never).operations;
    const first = await newReservation();
    const usage = await caller().pointsLedger.recordUsage({ entitlementId: booked, points: 100, reservationId: first, requestId: randomUUID() });
    await expect(ops().updateReservationStatus({ id: first, status: "cancelled" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller("admin").pointsLedger.reverse({ entryId: usage.entryId, note: "Reserva desfeita" });
    await ops().updateReservationStatus({ id: first, status: "cancelled" });

    for (let round = 0; round < 8; round += 1) {
      const racing = await newReservation();
      await Promise.allSettled([
        caller().pointsLedger.recordUsage({ entitlementId: booked, points: 10, reservationId: racing, requestId: randomUUID() }),
        ops().updateReservationStatus({ id: racing, status: "cancelled" }),
      ]);
      const [{ status }] = await db.select({ status: reservations.status }).from(reservations).where(eq(reservations.id, racing));
      const rows = await db.select().from(pointsLedger).where(eq(pointsLedger.reservationId, racing));
      const reversedIds = new Set(rows.map(row => row.reversesEntryId));
      const activeUsage = rows.some(row => row.entryType === "usage" && !reversedIds.has(row.id));
      expect(status === "cancelled" && activeUsage).toBe(false);
    }
  });
  it("pontos valem 2 anos: o vencido sai do disponível, o uso consome o mais antigo primeiro, a baixa grava uma vez e crédito vencido não entra nem estorna", async () => {
    const [{ id: aged }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 1000, validFrom: new Date("2022-01-01T12:00:00Z"), validUntil: new Date("2035-12-31T12:00:00Z") }).$returningId();
    // Histórico sintético: créditos de 2023, 2024 e 2025 e um uso de 500 (que consumiu o mais antigo).
    const [credit2023] = await db.insert(pointsLedger).values({ entitlementId: aged, entryType: "annual_credit", points: 1000, referenceYear: 2023, idempotencyKey: `annual:${aged}:2023`, createdByUserId: userId }).$returningId();
    await db.insert(pointsLedger).values([
      { entitlementId: aged, entryType: "annual_credit", points: 1000, referenceYear: 2024, idempotencyKey: `annual:${aged}:2024`, createdByUserId: userId },
      { entitlementId: aged, entryType: "annual_credit", points: 1000, referenceYear: 2025, idempotencyKey: `annual:${aged}:2025`, createdByUserId: userId },
      { entitlementId: aged, entryType: "usage", points: -500, idempotencyKey: `usage:${aged}:${randomUUID()}`, createdByUserId: userId },
    ]);
    // Antes de qualquer lançamento, o extrato já mostra o disponível sem o vencido: 500 de 2023 e 1000 de 2024 venceram.
    const before = await caller().pointsLedger.statement({ entitlementId: aged });
    expect(before.balance).toBe(2500);
    expect(before.available).toBe(1000);
    expect(before.pendingExpirations).toEqual([{ year: 2023, points: 500 }, { year: 2024, points: 1000 }]);
    expect(before.entries.find(entry => entry.referenceYear === 2025 && entry.entryType === "annual_credit")?.expiresOn).toBe("2026-12-31");
    // Só 1000 (de 2025) está disponível: 1001 é recusado, e a baixa do vencido já ficou gravada.
    await expect(caller().pointsLedger.recordUsage({ entitlementId: aged, points: 1001, requestId: randomUUID() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const settled = await db.select().from(pointsLedger).where(eq(pointsLedger.entitlementId, aged));
    const expirations = settled.filter(row => row.entryType === "expiration");
    expect(expirations.map(row => [row.referenceYear, row.points]).sort()).toEqual([[2023, -500], [2024, -1000]]);
    expect(expirations.every(row => row.createdByUserId === null)).toBe(true);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${expirations[0]!.id}`))).toHaveLength(1);
    // Dois lançamentos ao mesmo tempo não baixam o mesmo ano duas vezes.
    await Promise.allSettled([1, 2, 3].map(() => caller().pointsLedger.recordUsage({ entitlementId: aged, points: 100, requestId: randomUUID() })));
    expect((await db.select().from(pointsLedger).where(eq(pointsLedger.entitlementId, aged))).filter(row => row.entryType === "expiration")).toHaveLength(2);
    const after = await caller().pointsLedger.statement({ entitlementId: aged });
    expect(after.pendingExpirations).toEqual([]);
    expect(after.available).toBe(after.balance);
    expect(after.balance).toBe(700);
    // Auditoria que faltou no vencimento volta no lançamento seguinte, sem duplicar.
    await db.delete(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${expirations[0]!.id}`));
    await caller().pointsLedger.recordUsage({ entitlementId: aged, points: 1, requestId: randomUUID() });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.idempotencyKey, `points_ledger:${expirations[0]!.id}`))).toHaveLength(1);
    // Crédito de ano que já venceu não entra, e o crédito vencido não se estorna (correção é ajuste).
    await expect(caller().pointsLedger.creditAnnual({ entitlementId: aged, year: 2022 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller("admin").pointsLedger.reverse({ entryId: credit2023.id, note: "Tentativa de estorno" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("ajuste a favor estornado antes do vencimento não protege crédito vencido", async () => {
    const [{ id: shielded }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 1000, validFrom: new Date("2022-01-01T12:00:00Z"), validUntil: new Date("2035-12-31T12:00:00Z") }).$returningId();
    await db.insert(pointsLedger).values({ entitlementId: shielded, entryType: "annual_credit", points: 1000, referenceYear: 2024, idempotencyKey: `annual:${shielded}:2024`, createdByUserId: userId });
    const [bonus] = await db.insert(pointsLedger).values({ entitlementId: shielded, entryType: "adjustment", points: 400, note: "Bônus lançado e desfeito", idempotencyKey: `adjustment:${shielded}:${randomUUID()}`, createdByUserId: userId }).$returningId();
    await db.insert(pointsLedger).values({ entitlementId: shielded, entryType: "reversal", points: -400, reversesEntryId: bonus.id, note: "Bônus desfeito", idempotencyKey: `reversal:${bonus.id}`, createdByUserId: userId });
    const statement = await caller().pointsLedger.statement({ entitlementId: shielded });
    expect(statement.balance).toBe(1000);
    expect(statement.pendingExpirations).toEqual([{ year: 2024, points: 1000 }]);
    expect(statement.available).toBe(0);
  });

  it("a varredura do vencimento baixa o vencido sem esperar lançamento, uma vez só, e não toca crédito dentro da validade", async () => {
    const { settleAllExpirations } = await import("./routers/pointsLedger");
    const [{ id: stale }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 1000 }).$returningId();
    const [{ id: fresh }] = await db.insert(ownershipEntitlements).values({ contractId: contractIdForRace, resortId: resortIdForRace, entitlementType: "points", annualPoints: 1000 }).$returningId();
    await db.insert(pointsLedger).values([
      { entitlementId: stale, entryType: "annual_credit", points: 1000, referenceYear: 2021, createdByUserId: userId },
      { entitlementId: stale, entryType: "annual_credit", points: 500, referenceYear: 2026, createdByUserId: userId },
      { entitlementId: fresh, entryType: "annual_credit", points: 700, referenceYear: 2026, createdByUserId: userId },
    ]);
    const first = await settleAllExpirations();
    expect(first.settled).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(pointsLedger).where(eq(pointsLedger.entitlementId, stale));
    const expirations = rows.filter(row => row.entryType === "expiration");
    expect(expirations).toHaveLength(1);
    expect(expirations[0]).toMatchObject({ points: -1000, referenceYear: 2021, createdByUserId: null });
    expect((await caller().pointsLedger.statement({ entitlementId: stale })).available).toBe(500);
    const second = await settleAllExpirations();
    expect(second.settled).toBe(0);
    expect((await db.select().from(pointsLedger).where(eq(pointsLedger.entitlementId, stale))).filter(row => row.entryType === "expiration")).toHaveLength(1);
    expect((await db.select().from(pointsLedger).where(eq(pointsLedger.entitlementId, fresh))).filter(row => row.entryType === "expiration")).toHaveLength(0);
  });
});
