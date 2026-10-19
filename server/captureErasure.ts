import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLogs, captureErasureRequests, captureRecords, contracts, csvImportItems, customerContacts, customerDocuments, customerInteractions, customers, domainEvents, opportunities, reservations, tasks, vouchers, reservationWaitlist } from "../drizzle/schema";
import type { getDb } from "./db";
import { txAudit } from "./txOutbox";

/**
 * Pedido de exclusão/anonimização do titular (LGPD art. 18, CRM-A18). Dois passos, os dois na trilha:
 *  1. o administrativo (admin ou finance) registra o pedido, com o motivo;
 *  2. só a administração cumpre, digitando o código do casal da ficha (confirmação), ou recusa com justificativa.
 * Cumprido, sobra o registro mínimo: nome e CPF do cliente, o código e as datas da ficha, e a data do brinde gravada no pedido
 * (antiduplicidade dos 30 dias e defesa em eventual disputa). Todo o resto do cadastro e das fichas do cliente é limpo.
 * Cliente com contrato, reserva, documento ou venda marcada na sala NÃO é anonimizado por aqui: guarda legal do contrato
 * pede decisão humana (o pedido é recusado com o motivo). O CRM não é dono do dado que mora em outro sistema (Sales Command,
 * Relationship, Financial): a cópia deles é tratada por eles; a trilha do pedido serve de prova para quem precisar replicar.
 */
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Texto que fica no lugar do conteúdo apagado onde a coluna não aceita nulo. */
export const ERASED_TEXT = "[removido a pedido do titular]";

/** Colunas pessoais da ficha de captação que viram vazio na anonimização (o que sobra é operacional: código, datas, sala, equipe, resultado). */
export const CAPTURE_ERASED_PATCH = {
  lodgingLocation: null, receptionNotes: null, qualificationReason: null, noTourReason: null, commercialOutcomeReason: null, commercialOutcomeComplement: null, ntComplement: null,
  partnerName: null, partnerAge: null, partnerProfession: null, partnerProfessionNotes: null, relationshipStatus: null, relationshipYears: null, relationshipMonths: null,
  childrenCount: 0, childrenNames: null, primaryProfessionNotes: null, averageIncome: null, vehicleBrand: null, vehicleModel: null, vehicleYear: null,
  hasCreditCard: null, creditCardBrands: null, acceptsCheque: null, ownsHome: null, ownsPropertyInCity: null, travelWeeksPerYear: null, usualTravelSeason: null,
  dreamTrips: null, lastTrip: null, averageHotelSpend: null, nextFamilyTrip: null, socialNetworks: null, giftDescription: null, notes: null,
  secondVehicleModel: null, secondVehicleYear: null, retiredPrimary: null, retiredPartner: null, guest1Name: null, guest2Name: null,
  maleSpouse: null, vehicleKind: null, secondVehicleKind: null, watchedVacationPresentation: null,
} as const;

/** Colunas pessoais do cadastro do cliente que viram vazio (ficam fullName e documentNumber). */
export const CUSTOMER_ERASED_PATCH = {
  email: null, phone: null, birthDate: null, maritalStatus: null, occupation: null, zipCode: null, address: null, addressNumber: null, complement: null,
  neighborhood: null, city: null, state: null, acquisitionSource: null, notes: null, status: "inactive" as const,
};

const refuse = (message: string) => new TRPCError({ code: "PRECONDITION_FAILED", message });

/** O que impede a anonimização por aqui (guarda legal): vazio quando pode seguir. */
export async function erasureBlockers(executor: Db | Tx, customerId: number, captureIds: number[]) {
  const count = async (table: typeof contracts | typeof reservations | typeof customerDocuments | typeof reservationWaitlist) => {
    const [row] = await executor.select({ n: sql<number>`COUNT(*)` }).from(table as typeof contracts).where(eq((table as typeof contracts).customerId, customerId));
    return Number(row?.n ?? 0);
  };
  const blockers: string[] = [];
  if (await count(contracts)) blockers.push("tem contrato");
  if (await count(reservations)) blockers.push("tem reserva");
  if (await count(customerDocuments)) blockers.push("tem documento anexado");
  if (await count(reservationWaitlist)) blockers.push("está na lista de espera");
  if (captureIds.length) {
    const [sold] = await executor.select({ n: sql<number>`COUNT(*)` }).from(captureRecords).where(and(inArray(captureRecords.id, captureIds), eq(captureRecords.commercialOutcome, "vendeu")));
    if (Number(sold?.n ?? 0)) blockers.push("tem ficha marcada VENDEU");
  }
  return blockers;
}

/** Lista de PERMISSÃO das chaves de payload que sobram nos eventos do titular: ids, estados e contadores (nunca texto livre). Qualquer chave nova some por padrão. */
const EVENT_SAFE_KEYS = new Set([
  "status", "stage", "type", "direction", "outcome", "ntKind", "presentationStatus", "qualificationStatus", "durationMinutes", "salesRoom", "salesTable",
  "customerId", "captureId", "opportunityId", "campaignId", "sellerId", "linerId", "closerId", "roomManagerId", "role", "evidenceCount", "model",
]);

/**
 * Cópias secundárias persistidas do dado pessoal, limpas na mesma transação: snapshot de importação CSV (linha inteira do cliente),
 * payload dos eventos de domínio do cliente, das fichas, das oportunidades e das interações (lista de permissão: só chaves seguras
 * com valor simples) e o motivo de cancelamento de voucher na trilha. Ficam a trilha em si (quem, quando, o quê) e o nome/CPF mínimo.
 * Eventos já entregues a outros sistemas não são recolhidos aqui.
 */
export async function scrubSecondaryCopies(tx: Tx, customerId: number, captureIds: number[]) {
  await tx.update(csvImportItems).set({ beforeSnapshot: null }).where(and(eq(csvImportItems.entityType, "customer"), eq(csvImportItems.entityId, customerId)));
  const opportunityIds = (await tx.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.customerId, customerId))).map(row => String(row.id));
  const interactionIds = (await tx.select({ id: customerInteractions.id }).from(customerInteractions).where(eq(customerInteractions.customerId, customerId))).map(row => String(row.id));
  const scopes: Array<[string, string[]]> = [["customer", [String(customerId)]], ["capture", captureIds.map(String)], ["opportunity", opportunityIds], ["customer_interaction", interactionIds]];
  for (const [aggregateType, ids] of scopes) {
    if (!ids.length) continue;
    const events = await tx.select({ id: domainEvents.id, payload: domainEvents.payload }).from(domainEvents).where(and(eq(domainEvents.aggregateType, aggregateType), inArray(domainEvents.aggregateId, ids)));
    for (const event of events) {
      if (!event.payload) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(event.payload); } catch { continue; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (EVENT_SAFE_KEYS.has(key) && (value === null || ["number", "boolean"].includes(typeof value) || (typeof value === "string" && value.length <= 40))) kept[key] = value;
      }
      const next = JSON.stringify(kept);
      if (next !== event.payload) await tx.update(domainEvents).set({ payload: next }).where(eq(domainEvents.id, event.id));
    }
  }
  const voucherRows = await tx.select({ id: vouchers.id, code: vouchers.code }).from(vouchers).where(eq(vouchers.customerId, customerId));
  for (const voucher of voucherRows) await tx.update(auditLogs).set({ summary: `Voucher ${voucher.code} cancelado.` }).where(and(eq(auditLogs.entityType, "voucher"), eq(auditLogs.entityId, String(voucher.id)), eq(auditLogs.action, "cancelled")));
}

async function lockedCaptureByCode(tx: Tx, code: string) {
  const [capture] = await tx.select().from(captureRecords).where(eq(captureRecords.coupleCode, code)).limit(1).for("update");
  if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Nenhuma ficha com este código." });
  return capture;
}

/** Passo 1: registra o pedido. Recusa quando já foi anonimizada, quando já há pedido aberto ou quando a guarda legal impede. */
export async function requestErasure(db: Db, input: { code: string; reason: string; actorUserId: number }) {
  return db.transaction(async tx => {
    const capture = await lockedCaptureByCode(tx, input.code);
    if (capture.anonymizedAt) throw refuse("Esta ficha já foi anonimizada.");
    // Um pedido aberto por CLIENTE (não por ficha): o cliente com várias fichas irmãs é anonimizado de uma vez. A trava da linha do cliente
    // serializa dois pedidos concorrentes para fichas irmãs (mesma ordem de trava do cumprimento: ficha, depois cliente).
    await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, capture.customerId)).limit(1).for("update");
    const [open] = await tx.select({ id: captureErasureRequests.id }).from(captureErasureRequests).where(and(eq(captureErasureRequests.customerId, capture.customerId), eq(captureErasureRequests.status, "requested"))).limit(1);
    if (open) throw refuse(`Já existe o pedido ${open.id} aberto para este cliente.`);
    const siblings = await tx.select({ id: captureRecords.id }).from(captureRecords).where(eq(captureRecords.customerId, capture.customerId));
    const blockers = await erasureBlockers(tx, capture.customerId, siblings.map(row => row.id));
    if (blockers.length) throw refuse(`Não dá para anonimizar por aqui: o cliente ${blockers.join(", ")}. A guarda legal do contrato pede decisão da administração e do jurídico.`);
    const [{ id }] = await tx.insert(captureErasureRequests).values({ captureId: capture.id, customerId: capture.customerId, coupleCode: input.code, reason: input.reason, requestedByUserId: input.actorUserId }).$returningId();
    await txAudit(tx, { actorUserId: input.actorUserId, entityType: "capture", entityId: capture.id, action: "erasure_requested", summary: `Ficha ${capture.id}: pedido de exclusão ${id} registrado (aguarda confirmação da administração).` });
    return { requestId: id };
  });
}

/** Passo 2: cumpre o pedido. A confirmação é o código do casal digitado igual ao da ficha. */
export async function completeErasure(db: Db, input: { requestId: number; confirmCode: string; actorUserId: number }) {
  return db.transaction(async tx => {
    const [request] = await tx.select().from(captureErasureRequests).where(eq(captureErasureRequests.id, input.requestId)).limit(1).for("update");
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
    if (request.status !== "requested") throw refuse("Este pedido já foi decidido.");
    if (input.confirmCode !== request.coupleCode) throw new TRPCError({ code: "BAD_REQUEST", message: "Confirmação errada: digite o código do casal desta ficha." });
    const capture = await lockedCaptureByCode(tx, request.coupleCode);
    const [customer] = await tx.select().from(customers).where(eq(customers.id, request.customerId)).limit(1).for("update");
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente não encontrado." });
    const sheets = await tx.select({ id: captureRecords.id, createdAt: captureRecords.createdAt }).from(captureRecords).where(eq(captureRecords.customerId, customer.id)).for("update");
    const blockers = await erasureBlockers(tx, customer.id, sheets.map(row => row.id));
    if (blockers.length) throw refuse(`Não dá para anonimizar por aqui: o cliente ${blockers.join(", ")}.`);
    // Data do brinde: primeiro voucher não cancelado; sem voucher, a criação da ficha mais antiga.
    const [gift] = await tx.select({ at: sql<Date | string | null>`MIN(${vouchers.issuedAt})` }).from(vouchers).where(and(eq(vouchers.customerId, customer.id), sql`${vouchers.status} <> 'cancelled'`));
    const earliestSheet = sheets.map(row => row.createdAt).sort((a, b) => a.getTime() - b.getTime())[0] ?? capture.createdAt;
    const giftDate = gift?.at ? new Date(gift.at as string | Date) : earliestSheet;
    const now = new Date();

    await tx.update(captureRecords).set({ ...CAPTURE_ERASED_PATCH, anonymizedAt: now }).where(inArray(captureRecords.id, sheets.map(row => row.id)));
    await tx.update(customers).set({ ...CUSTOMER_ERASED_PATCH, anonymizedAt: now }).where(eq(customers.id, customer.id));
    await tx.delete(customerContacts).where(eq(customerContacts.customerId, customer.id));
    await tx.update(customerInteractions).set({ subject: null, content: ERASED_TEXT }).where(eq(customerInteractions.customerId, customer.id));
    await tx.update(opportunities).set({ title: "Oportunidade anonimizada", lossReason: null }).where(eq(opportunities.customerId, customer.id));
    await tx.update(tasks).set({ description: null }).where(eq(tasks.customerId, customer.id));
    await tx.update(vouchers).set({ redeemNote: null, cancelReason: null }).where(eq(vouchers.customerId, customer.id));
    await scrubSecondaryCopies(tx, customer.id, sheets.map(row => row.id));
    await tx.update(captureErasureRequests).set({ status: "completed", decidedByUserId: input.actorUserId, decidedAt: now, giftDate, sheetsAnonymized: sheets.length }).where(eq(captureErasureRequests.id, request.id));
    await txAudit(tx, { actorUserId: input.actorUserId, entityType: "capture", entityId: capture.id, action: "erasure_completed", summary: `Ficha ${capture.id}: pedido ${request.id} cumprido. ${sheets.length} ficha(s) do cliente ${customer.id} anonimizada(s); ficam só nome, CPF e a data do brinde.` });
    await txAudit(tx, { actorUserId: input.actorUserId, entityType: "customer", entityId: customer.id, action: "anonymized", summary: `Cliente ${customer.id} anonimizado a pedido do titular (pedido ${request.id}).` });
    return { requestId: request.id, sheetsAnonymized: sheets.length, giftDate };
  });
}

/** Recusa o pedido com justificativa (ex.: não é o titular, ou a guarda legal manda guardar). Nada é apagado. */
export async function rejectErasure(db: Db, input: { requestId: number; note: string; actorUserId: number }) {
  return db.transaction(async tx => {
    const [request] = await tx.select().from(captureErasureRequests).where(eq(captureErasureRequests.id, input.requestId)).limit(1).for("update");
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
    if (request.status !== "requested") throw refuse("Este pedido já foi decidido.");
    await tx.update(captureErasureRequests).set({ status: "rejected", decidedByUserId: input.actorUserId, decidedAt: new Date(), decisionNote: input.note }).where(eq(captureErasureRequests.id, request.id));
    await txAudit(tx, { actorUserId: input.actorUserId, entityType: "capture", entityId: request.captureId, action: "erasure_rejected", summary: `Ficha ${request.captureId}: pedido de exclusão ${request.id} recusado pela administração.` });
    return { requestId: request.id };
  });
}

export function listErasureRequests(db: Db, code: string) {
  return db.select({ id: captureErasureRequests.id, status: captureErasureRequests.status, reason: captureErasureRequests.reason, requestedAt: captureErasureRequests.requestedAt, decidedAt: captureErasureRequests.decidedAt, decisionNote: captureErasureRequests.decisionNote, giftDate: captureErasureRequests.giftDate, sheetsAnonymized: captureErasureRequests.sheetsAnonymized })
    .from(captureErasureRequests).where(eq(captureErasureRequests.coupleCode, code)).orderBy(sql`${captureErasureRequests.id} DESC`).limit(20);
}
