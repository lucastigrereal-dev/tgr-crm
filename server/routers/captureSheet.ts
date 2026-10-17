import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { z } from "zod";
import { captureRecords, captureSheetPrints, captureSheetSettings, captureTeamMembers, captureTeamRoles, customerContacts, customers, users, vouchers } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, assertCapability, internalProcedure, receptionProcedure, salesProcedure } from "./access";
import { txAudit } from "../txOutbox";
import { DEFAULT_MIN_PRESENTATION_MINUTES, DEFAULT_NQ_SETTINGS, PRIVACY_TEXT_KEYS, REPRINT_ALERT_THRESHOLD, addCalendarDays, ageInYears, arrivalOrder, canOpenArchivedSheet, computeNq, isCoupleCode, localDayStart, normalizeCoupleCode, paperCustodyOfSheet, privacyNoticeText, relationshipDays, roomVisibility, type NqSettings, type PrivacySettings } from "../captureSheetDomain";
import type { CaptureExportSource } from "../../shared/captureSheetExport";
import { affectedRows, isDuplicateKeyError } from "../mysqlErrors";
import { localDateInTimezone } from "../saleTermsPolicy";

/**
 * Ficha impressa com QR (TSE x CRM, pacotes 2, 3 e 5): a ficha abre pelo código do casal do Sales Command; o QR de bip é o da recepção (token secreto só na Suite), a folha só tem o espaço dele, equipe por papel, PEP e campos novos.
 * Versão nova, fora do piloto. O tempo por papel (bip) é do Sales Command; aqui só mora a ficha e o QR.
 */
const projectTimezone = () => ENV.financialProjectTimezone.trim() || "America/Recife";
const optionalName = z.string().trim().max(180).optional().nullable();

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  return db;
}

const PANEL_LIMIT = 2000;
const SETTING_KEYS = ["nq_min_man_age", "nq_min_relationship_months", "nq_min_vehicle_year", "nq_min_income", "nq_max_items_accepted", "min_presentation_minutes", "room_visibility_days", "paper_destroy_deadline_days", "brand_name", ...PRIVACY_TEXT_KEYS] as const;
/** Chaves de texto livre (marca e aviso de privacidade): sem validação numérica. */
const TEXT_SETTING_KEYS: ReadonlySet<string> = new Set(["brand_name", ...PRIVACY_TEXT_KEYS]);

const SETTING_RANGES = { nq_min_man_age: [0, 120], nq_min_relationship_months: [0, 600], nq_min_vehicle_year: [1950, 2100], nq_min_income: [0, 1_000_000], nq_max_items_accepted: [0, 7], min_presentation_minutes: [0, 600], room_visibility_days: [0, 3650], paper_destroy_deadline_days: [0, 365] } as const;

/** Limites provisórios gravados (ou o padrão quando a linha não existe): nada aqui é regra homologada. */
async function loadSettings(db: Awaited<ReturnType<typeof requireDb>>) {
  const rows = await db.select().from(captureSheetSettings);
  const map = new Map(rows.map(row => [row.key, row]));
  const num = (key: string, fallback: number) => { const value = Number(map.get(key)?.value); return Number.isFinite(value) && map.get(key)?.value !== "" ? value : fallback; };
  const nq: NqSettings = { minManAge: num("nq_min_man_age", DEFAULT_NQ_SETTINGS.minManAge), minRelationshipMonths: num("nq_min_relationship_months", DEFAULT_NQ_SETTINGS.minRelationshipMonths), minVehicleYear: num("nq_min_vehicle_year", DEFAULT_NQ_SETTINGS.minVehicleYear), minIncome: num("nq_min_income", DEFAULT_NQ_SETTINGS.minIncome), maxItemsAccepted: num("nq_max_items_accepted", DEFAULT_NQ_SETTINGS.maxItemsAccepted) };
  const privacy = Object.fromEntries(PRIVACY_TEXT_KEYS.map(key => [key, map.get(key)?.value ?? ""])) as PrivacySettings;
  // LGPD (decisão do Lucas 17/10): 0 dias = ficha de quem não comprou sai da vista da sala depois do dia da visita; papel destruído no mesmo dia.
  return { nq, minPresentationMinutes: num("min_presentation_minutes", DEFAULT_MIN_PRESENTATION_MINUTES), brandName: map.get("brand_name")?.value ?? "", roomVisibilityDays: num("room_visibility_days", 0), paperDestroyDeadlineDays: num("paper_destroy_deadline_days", 0), privacy, rows };
}
type SheetSettings = Awaited<ReturnType<typeof loadSettings>>;

const todayLocal = () => localDateInTimezone(new Date(), projectTimezone());
/** Dia da visita no calendário do projeto: check-in; sem check-in, o agendamento; sem agendamento, a criação da ficha. */
const visitDayOf = (capture: { checkedInAt: Date | null; scheduledAt?: Date | null; createdAt: Date }) => localDateInTimezone(capture.checkedInAt ?? capture.scheduledAt ?? capture.createdAt, projectTimezone());

function visibilityOf(capture: { checkedInAt: Date | null; scheduledAt?: Date | null; createdAt: Date; commercialOutcome: "vendeu" | "caiu_em_mesa" | null }, settings: SheetSettings) {
  return roomVisibility({ visitDay: visitDayOf(capture), today: todayLocal(), roomVisibilityDays: settings.roomVisibilityDays, commercialOutcome: capture.commercialOutcome });
}

/** Ficha fora da vista da sala só abre (e só imprime) para o administrativo. A ficha digital não é apagada: só muda quem a vê. */
function assertSheetVisibleTo(role: string, capture: { checkedInAt: Date | null; scheduledAt?: Date | null; createdAt: Date; commercialOutcome: "vendeu" | "caiu_em_mesa" | null }, settings: SheetSettings) {
  const visibility = visibilityOf(capture, settings);
  if (!visibility.visibleToRoom && !canOpenArchivedSheet(role)) throw new TRPCError({ code: "FORBIDDEN", message: "Esta ficha saiu da vista da sala (o casal não comprou). Só a administração e o financeiro abrem." });
  return visibility;
}

/** Mutações da sala (check-in, mesa, apresentação, resultado) por id: quem não é administrativo não age sobre ficha que saiu da vista da sala. */
export async function assertCaptureInRoomView(db: Awaited<ReturnType<typeof requireDb>>, role: string, capture: { checkedInAt: Date | null; scheduledAt?: Date | null; createdAt: Date; commercialOutcome: "vendeu" | "caiu_em_mesa" | null }) {
  if (canOpenArchivedSheet(role)) return;
  assertSheetVisibleTo(role, capture, await loadSettings(db));
}

/**
 * Corte da vista da sala para consultas em lote (lista e exportação): fichas visitadas antes deste instante só aparecem
 * para a sala se tiveram VENDEU. Mesma regra de `roomVisibility`, em SQL.
 */
export async function roomVisibilityCutoff() {
  const db = await requireDb();
  const settings = await loadSettings(db);
  const firstRoomDay = addCalendarDays(todayLocal(), -settings.roomVisibilityDays);
  return localDayStart(firstRoomDay, projectTimezone(), localDateInTimezone);
}
export function roomVisibleCondition(cutoff: Date) {
  // O corte vai como texto UTC: as colunas timestamp do drizzle guardam e leem em UTC, e um Date cru seria serializado no fuso do processo.
  const utc = cutoff.toISOString().slice(0, 23).replace("T", " ");
  return or(eq(captureRecords.commercialOutcome, "vendeu"), sql`COALESCE(${captureRecords.checkedInAt}, ${captureRecords.scheduledAt}, ${captureRecords.createdAt}) >= ${utc}`);
}

async function captureByCode(rawCode: string) {
  const code = normalizeCoupleCode(rawCode);
  if (!isCoupleCode(code)) throw new TRPCError({ code: "NOT_FOUND", message: "Código da ficha inválido." });
  const db = await requireDb();
  const [row] = await db.select({ capture: captureRecords, customer: customers }).from(captureRecords).innerJoin(customers, eq(customers.id, captureRecords.customerId)).where(eq(captureRecords.coupleCode, code)).limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Nenhuma ficha com este código." });
  // Devolve a grafia gravada: a busca ignora maiúsculas, mas a folha tem que imprimir o código como o Sales Command o emitiu.
  return { db, code: row.capture.coupleCode ?? code, ...row };
}

export const captureSheetRouter = router({
  /** Liga a ficha ao código do casal do Sales Command (o do QR impresso). Trocar o código é auditado. */
  setCoupleCode: salesProcedure.input(z.object({ captureId: z.number().int().positive(), coupleCode: z.string().max(64) })).mutation(async ({ ctx, input }) => {
    const code = normalizeCoupleCode(input.coupleCode);
    if (!isCoupleCode(code)) throw new TRPCError({ code: "BAD_REQUEST", message: "Código inválido: use de 4 a 64 letras, números, - ou _ (nunca CPF ou telefone)." });
    const db = await requireDb();
    const sheetSettings = await loadSettings(db);
    // Ficha travada na leitura e na gravação: duas ligações ao mesmo tempo não passam as duas como "primeira ligação".
    await db.transaction(async tx => {
      const [capture] = await tx.select({ id: captureRecords.id, coupleCode: captureRecords.coupleCode, checkedInAt: captureRecords.checkedInAt, scheduledAt: captureRecords.scheduledAt, createdAt: captureRecords.createdAt, commercialOutcome: captureRecords.commercialOutcome }).from(captureRecords).where(eq(captureRecords.id, input.captureId)).limit(1).for("update");
      if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
      assertSheetVisibleTo(ctx.user.role, capture, sheetSettings);
      if (capture.coupleCode === code) return;
      if (capture.coupleCode && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só a administração troca o código de uma ficha que já tem código." });
      try {
        await tx.update(captureRecords).set({ coupleCode: code }).where(eq(captureRecords.id, input.captureId));
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new TRPCError({ code: "CONFLICT", message: "Este código já está ligado a outra ficha." });
        throw error;
      }
      // A trilha entra na mesma transação da troca: se uma falhar, a outra não fica.
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture", entityId: input.captureId, action: "couple_code_set", summary: capture.coupleCode ? `Ficha ${input.captureId}: código do casal trocado de ${capture.coupleCode} para ${code}.` : `Ficha ${input.captureId}: código do casal ${code} ligado.` });
    });
    return { code };
  }),

  /** Código da ficha pelo id, para a lista abrir a impressão. */
  /** Dia de hoje no calendário do projeto (fuso configurado no servidor): o painel e a exportação do navegador partem daqui. */
  today: internalProcedure.query(() => ({ today: todayLocal() })),

  codeOf: internalProcedure.input(z.object({ captureId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await requireDb();
    const [capture] = await db.select({ coupleCode: captureRecords.coupleCode }).from(captureRecords).where(eq(captureRecords.id, input.captureId)).limit(1);
    if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
    return { coupleCode: capture.coupleCode };
  }),

  /** Ficha completa para a tela e a impressão. Só quem tem login e permissão chega aqui. */
  byCode: internalProcedure.input(z.object({ code: z.string().max(64) })).query(async ({ ctx, input }) => {
    const { db, code, capture, customer } = await captureByCode(input.code);
    const settings = await loadSettings(db);
    // A conferência de vista vem ANTES da trilha e de qualquer dado: quem não pode abrir não gera "aberta" nem vê CPF.
    const visibility = assertSheetVisibleTo(ctx.user.role, capture, settings);
    // Trilha de abertura no mesmo caminho que devolve CPF e renda; recargas no mesmo minuto da mesma pessoa contam uma vez só.
    await recordAudit(ctx.user.id, "capture", capture.id, "sheet_opened", `Ficha ${capture.id} aberta.`, { idempotencyKey: `sheet_opened:${capture.id}:${ctx.user.id}:${Math.floor(Date.now() / 60_000)}` });
    const members = await db.select({ roleId: captureTeamRoles.id, code: captureTeamRoles.code, label: captureTeamRoles.label, kind: captureTeamRoles.kind, userId: captureTeamMembers.userId, personName: captureTeamMembers.personName, userName: users.name })
      .from(captureTeamMembers).innerJoin(captureTeamRoles, eq(captureTeamRoles.id, captureTeamMembers.roleId)).leftJoin(users, eq(users.id, captureTeamMembers.userId)).where(eq(captureTeamMembers.captureId, capture.id)).orderBy(asc(captureTeamRoles.sortOrder));
    const staffIds = [capture.promoterId, capture.qualifierId, capture.linerId, capture.closerId, capture.roomManagerId].filter((id): id is number => id != null);
    const staff = staffIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(sql`${users.id} IN (${sql.join(staffIds.map(id => sql`${id}`), sql`, `)})`) : [];
    const nameOf = (id: number | null) => (id == null ? null : staff.find(person => person.id === id)?.name ?? null);
    let order: number | null = null;
    if (capture.checkedInAt) {
      const tz = projectTimezone();
      const day = localDateInTimezone(capture.checkedInAt, tz);
      const from = new Date(capture.checkedInAt.getTime() - 36 * 3600_000), to = new Date(capture.checkedInAt.getTime() + 36 * 3600_000);
      // Mesma sala filtrada no SQL e sem corte de linhas: a janela de 72 h de uma sala cabe folgada, e a ordem nunca sai truncada.
      const sameRoom = capture.salesRoom == null ? isNull(captureRecords.salesRoom) : eq(captureRecords.salesRoom, capture.salesRoom);
      const near = await db.select({ id: captureRecords.id, checkedInAt: captureRecords.checkedInAt, salesRoom: captureRecords.salesRoom }).from(captureRecords).where(and(isNotNull(captureRecords.checkedInAt), gte(captureRecords.checkedInAt, from), lt(captureRecords.checkedInAt, to), sameRoom));
      order = arrivalOrder(capture, near.filter(row => row.checkedInAt && localDateInTimezone(row.checkedInAt, tz) === day));
    }
    const printFields = { id: captureSheetPrints.id, printedAt: captureSheetPrints.printedAt, collectedAt: captureSheetPrints.collectedAt, destroyedAt: captureSheetPrints.destroyedAt, destroyDeadlineDays: captureSheetPrints.destroyDeadlineDays };
    // Custódia olha a última impressão e TODA cópia ainda não destruída (sem corte): papel pendente nunca fica de fora.
    const [latestPrints, pendingPrints] = await Promise.all([
      db.select(printFields).from(captureSheetPrints).where(eq(captureSheetPrints.captureId, capture.id)).orderBy(desc(captureSheetPrints.printedAt), desc(captureSheetPrints.id)).limit(1),
      db.select(printFields).from(captureSheetPrints).where(and(eq(captureSheetPrints.captureId, capture.id), isNull(captureSheetPrints.destroyedAt))),
    ]);
    const printRows = [...latestPrints, ...pendingPrints.filter(row => row.id !== latestPrints[0]?.id)];
    const [{ total: prints }] = await db.select({ total: sql<number>`COUNT(*)` }).from(captureSheetPrints).where(eq(captureSheetPrints.captureId, capture.id));
    const lastPrint = printRows[0] ?? null;
    const paper = paperCustodyOfSheet(printRows.map(row => ({ printedDay: localDateInTimezone(row.printedAt, projectTimezone()), collectedAt: row.collectedAt, destroyedAt: row.destroyedAt, destroyDeadlineDays: row.destroyDeadlineDays })), todayLocal(), settings.paperDestroyDeadlineDays);
    // Todos os contatos ativos; o que já está no cadastro principal (telefone/e-mail do cliente) não repete, mas o WhatsApp preferido, que não espelha no cadastro, entra.
    const allContacts = await db.select({ kind: customerContacts.kind, label: customerContacts.label, value: customerContacts.value }).from(customerContacts).where(and(eq(customerContacts.customerId, customer.id), isNull(customerContacts.archivedAt), sql`${customerContacts.kind} IN ('phone', 'whatsapp', 'email')`)).orderBy(desc(customerContacts.isPreferred), asc(customerContacts.id)).limit(20);
    const digits = (value?: string | null) => (value ?? "").replace(/\D/g, "");
    const contacts = allContacts.filter(contact => (contact.kind === "email" ? contact.value.trim().toLowerCase() !== (customer.email ?? "").trim().toLowerCase() : digits(contact.value) !== digits(customer.phone))).slice(0, 10);
    const gifts = await db.select({ description: vouchers.description, status: vouchers.status }).from(vouchers).where(and(eq(vouchers.captureId, capture.id), sql`${vouchers.status} <> 'cancelled'`)).orderBy(asc(vouchers.id)).limit(20);
    // Idade no calendário do projeto (não em UTC): na virada do dia o aniversário não chega horas antes.
    const primaryAge = ageInYears(customer.birthDate, new Date(`${localDateInTimezone(new Date(), projectTimezone())}T00:00:00Z`));
    const nq = computeNq({ maleSpouse: capture.maleSpouse, primaryAge, partnerAge: capture.partnerAge, relationshipStatus: capture.relationshipStatus, relationshipYears: capture.relationshipYears, relationshipMonths: capture.relationshipMonths, vehicleKind: capture.vehicleKind, vehicleYear: capture.vehicleYear, secondVehicleKind: capture.secondVehicleKind, secondVehicleYear: capture.secondVehicleYear, averageIncome: capture.averageIncome, hasCreditCard: capture.hasCreditCard, ownsHome: capture.ownsHome }, settings.nq);
    return {
      captureId: capture.id,
      coupleCode: code,
      customer: { fullName: customer.fullName, documentNumber: customer.documentNumber, phone: customer.phone, email: customer.email, occupation: customer.occupation, age: primaryAge, city: customer.city, state: customer.state },
      contacts,
      gifts: gifts.map(gift => gift.description),
      nq,
      sheetSettings: { minPresentationMinutes: settings.minPresentationMinutes, brandName: settings.brandName },
      // LGPD: estado do papel, vista da sala e o aviso v1 (provisório) que sai na faixa destacável.
      paper: { ...paper, destroyDeadlineDays: lastPrint?.destroyDeadlineDays ?? settings.paperDestroyDeadlineDays, reprintAlert: prints >= REPRINT_ALERT_THRESHOLD, lastPrintedAt: lastPrint?.printedAt ?? null, collectedAt: lastPrint?.collectedAt ?? null, destroyedAt: lastPrint?.destroyedAt ?? null },
      roomVisibility: visibility,
      privacyNotice: privacyNoticeText(settings.privacy, settings.paperDestroyDeadlineDays),
      capture: {
        salesRoom: capture.salesRoom, captureLocation: capture.captureLocation, lodgingLocation: capture.lodgingLocation, transportation: capture.transportation, averageIncome: capture.averageIncome, createdAt: capture.createdAt, checkedInAt: capture.checkedInAt, presentationStatus: capture.presentationStatus, qualificationStatus: capture.qualificationStatus,
        partnerName: capture.partnerName, partnerAge: capture.partnerAge, relationshipStatus: capture.relationshipStatus, childrenCount: capture.childrenCount,
        vehicleBrand: capture.vehicleBrand, vehicleModel: capture.vehicleModel, vehicleYear: capture.vehicleYear, secondVehicleModel: capture.secondVehicleModel, secondVehicleYear: capture.secondVehicleYear,
        retiredPrimary: capture.retiredPrimary, retiredPartner: capture.retiredPartner, guest1Name: capture.guest1Name, guest2Name: capture.guest2Name,
        pepOffered: capture.pepOffered, pepOfferedBy: capture.pepOfferedBy, pepResult: capture.pepResult, notes: capture.notes,
        partnerProfession: capture.partnerProfession, partnerProfessionNotes: capture.partnerProfessionNotes, primaryProfessionNotes: capture.primaryProfessionNotes, childrenNames: capture.childrenNames, hasCreditCard: capture.hasCreditCard, ownsHome: capture.ownsHome, ownsPropertyInCity: capture.ownsPropertyInCity, lastTrip: capture.lastTrip, dreamTrips: capture.dreamTrips, giftDescription: capture.giftDescription,
        maleSpouse: capture.maleSpouse, vehicleKind: capture.vehicleKind, secondVehicleKind: capture.secondVehicleKind, watchedVacationPresentation: capture.watchedVacationPresentation, captureKind: capture.captureKind,
      },
      team: { promoter: nameOf(capture.promoterId), qualifier: nameOf(capture.qualifierId), liner: nameOf(capture.linerId), closer: nameOf(capture.closerId), roomManager: nameOf(capture.roomManagerId), members: members.map(member => ({ roleId: member.roleId, code: member.code, label: member.label, kind: member.kind, name: member.userName ?? member.personName })) },
      derived: { relationshipDays: relationshipDays(capture.relationshipYears, capture.relationshipMonths), arrivalOrder: order },
      printCount: Number(prints),
    };
  }),

  /** Registra a impressão. A primeira é a original; as seguintes são reimpressões. O QR é sempre o mesmo. */
  recordPrint: receptionProcedure.input(z.object({ code: z.string().max(64) })).mutation(async ({ ctx, input }) => {
    const code = normalizeCoupleCode(input.code);
    if (!isCoupleCode(code)) throw new TRPCError({ code: "NOT_FOUND", message: "Código da ficha inválido." });
    const db = await requireDb();
    const reprint = await db.transaction(async tx => {
      // O código é conferido com a ficha travada: se a administração trocar o código no meio, a impressão com o código velho é recusada.
      const [capture] = await tx.select({ id: captureRecords.id, checkedInAt: captureRecords.checkedInAt, scheduledAt: captureRecords.scheduledAt, createdAt: captureRecords.createdAt, commercialOutcome: captureRecords.commercialOutcome }).from(captureRecords).where(eq(captureRecords.coupleCode, code)).limit(1).for("update");
      if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Nenhuma ficha com este código." });
      const printSettings = await loadSettings(db);
      assertSheetVisibleTo(ctx.user.role, capture, printSettings);
      const [{ count }] = await tx.select({ count: sql<number>`COUNT(*)` }).from(captureSheetPrints).where(eq(captureSheetPrints.captureId, capture.id));
      const isReprint = Number(count) > 0;
      await tx.insert(captureSheetPrints).values({ captureId: capture.id, printedByUserId: ctx.user.id, reprint: isReprint, destroyDeadlineDays: printSettings.paperDestroyDeadlineDays });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture", entityId: capture.id, action: isReprint ? "sheet_reprinted" : "sheet_printed", summary: isReprint ? `Ficha ${capture.id} reimpressa.` : `Ficha ${capture.id} impressa.` });
      return isReprint;
    });
    return { reprint };
  }),

  /** Segundo carro, aposentado, convidado e oferta de PEP. Só altera o que veio na chamada. */
  updateExtras: salesProcedure.input(z.object({
    captureId: z.number().int().positive(),
    secondVehicleModel: z.string().trim().max(120).optional().nullable(),
    secondVehicleYear: z.number().int().min(1900).max(2100).optional().nullable(),
    retiredPrimary: z.boolean().optional().nullable(),
    retiredPartner: z.boolean().optional().nullable(),
    guest1Name: optionalName,
    guest2Name: optionalName,
    pepOffered: z.boolean().optional(),
    pepOfferedBy: optionalName,
    pepResult: z.enum(["accepted", "declined"]).optional().nullable(),
    maleSpouse: z.enum(["titular", "conjuge"]).optional().nullable(),
    vehicleKind: z.enum(["carro", "moto", "nenhum"]).optional().nullable(),
    secondVehicleKind: z.enum(["carro", "moto", "nenhum"]).optional().nullable(),
    watchedVacationPresentation: z.boolean().optional().nullable(),
    captureKind: z.string().trim().max(60).optional().nullable(),
    /** Nascimento do titular (a captação não pede): grava no cadastro do cliente para a idade do NQ fechar. */
    titularBirthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a data como AAAA-MM-DD.").optional().nullable(),
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const { captureId, titularBirthDate, ...fields } = input;
    if (titularBirthDate) {
      const parsed = new Date(`${titularBirthDate}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== titularBirthDate || parsed.getTime() > Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "Data de nascimento inválida." });
    }
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      patch[key] = typeof value === "string" ? (value.trim() || null) : value;
    }
    if (patch.pepResult && patch.pepOffered === false) throw new TRPCError({ code: "BAD_REQUEST", message: "Resultado do PEP só vale quando a oferta foi feita." });
    if (!Object.keys(patch).length && titularBirthDate === undefined) return { updated: false };
    const sheetSettings = await loadSettings(db);
    await db.transaction(async tx => {
      // Leitura e gravação juntas, com a ficha travada: duas abas não furam a regra "resultado só com oferta".
      const [existing] = await tx.select({ id: captureRecords.id, customerId: captureRecords.customerId, pepOffered: captureRecords.pepOffered, checkedInAt: captureRecords.checkedInAt, scheduledAt: captureRecords.scheduledAt, createdAt: captureRecords.createdAt, commercialOutcome: captureRecords.commercialOutcome }).from(captureRecords).where(eq(captureRecords.id, captureId)).limit(1).for("update");
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
      assertSheetVisibleTo(ctx.user.role, existing, sheetSettings);
      if (patch.pepResult && patch.pepOffered === undefined && !existing.pepOffered) throw new TRPCError({ code: "BAD_REQUEST", message: "Registre a oferta de PEP antes do resultado." });
      if (patch.pepOffered === false) { patch.pepResult = null; patch.pepOfferedBy = null; }
      if (Object.keys(patch).length) await tx.update(captureRecords).set(patch).where(eq(captureRecords.id, captureId));
      if (titularBirthDate !== undefined) {
        await tx.update(customers).set({ birthDate: titularBirthDate ? new Date(`${titularBirthDate}T12:00:00Z`) : null }).where(eq(customers.id, existing.customerId));
        await txAudit(tx, { actorUserId: ctx.user.id, entityType: "customer", entityId: existing.customerId, action: "birth_date_set_from_sheet", summary: `Ficha ${captureId}: nascimento do titular ${titularBirthDate ? "informado" : "limpo"}.` });
      }
      if (Object.keys(patch).length) await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture", entityId: captureId, action: "sheet_extras_updated", summary: `Ficha ${captureId}: campos da sala atualizados (${Object.keys(patch).join(", ")}).` });
    });
    return { updated: true };
  }),

  /** Limites provisórios do casal qualificado e do termo de ciência. Qualquer um da recepção lê; só a administração altera, com trilha do valor antigo e do novo. */
  settings: router({
    get: receptionProcedure.query(async () => {
      const db = await requireDb();
      const settings = await loadSettings(db);
      return { nq: settings.nq, minPresentationMinutes: settings.minPresentationMinutes, brandName: settings.brandName, roomVisibilityDays: settings.roomVisibilityDays, paperDestroyDeadlineDays: settings.paperDestroyDeadlineDays, privacy: settings.privacy, provisional: true };
    }),
    set: adminProcedure.input(z.object({ key: z.enum(SETTING_KEYS), value: z.string().trim().max(255) })).mutation(async ({ ctx, input }) => {
      if (!TEXT_SETTING_KEYS.has(input.key)) {
        const value = Number(input.value);
        const range = SETTING_RANGES[input.key as keyof typeof SETTING_RANGES];
        if (input.value === "" || !Number.isInteger(value) || value < range[0] || value > range[1]) throw new TRPCError({ code: "BAD_REQUEST", message: `Informe um número inteiro entre ${range[0]} e ${range[1]}.` });
      }
      const db = await requireDb();
      await db.transaction(async tx => {
        const [old] = await tx.select().from(captureSheetSettings).where(eq(captureSheetSettings.key, input.key)).limit(1).for("update");
        await tx.insert(captureSheetSettings).values({ key: input.key, value: input.value, provisional: true, updatedByUserId: ctx.user.id }).onDuplicateKeyUpdate({ set: { value: input.value, updatedByUserId: ctx.user.id } });
        await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture_sheet_setting", entityId: input.key, action: "updated", summary: `Limite da ficha "${input.key}" mudou de "${old?.value ?? "(padrão)"}" para "${input.value}".` });
      });
      return { ok: true };
    }),
  }),

  /**
   * Cadeia de custódia do papel (parecer LGPD A1, decisão do Lucas 17/10): recolhido e destruído ficam gravados em cada
   * impressão. Recolher e destruir não devolvem dado pessoal, então valem mesmo depois que a ficha saiu da vista da sala.
   */
  paper: router({
    collect: receptionProcedure.input(z.object({ code: z.string().max(64) })).mutation(async ({ ctx, input }) => {
      const { db, capture } = await captureByCode(input.code);
      const updated = await db.transaction(async tx => {
        const result = await tx.update(captureSheetPrints).set({ collectedAt: new Date(), collectedByUserId: ctx.user.id }).where(and(eq(captureSheetPrints.captureId, capture.id), isNull(captureSheetPrints.collectedAt)));
        const rows = affectedRows(result) ?? 0;
        if (rows) await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture", entityId: capture.id, action: "sheet_paper_collected", summary: `Ficha ${capture.id}: papel recolhido (${rows} impressão(ões)).` });
        return rows;
      });
      if (!updated) throw new TRPCError({ code: "BAD_REQUEST", message: "Nenhuma impressão em circulação para recolher." });
      return { collected: updated };
    }),
    destroy: receptionProcedure.input(z.object({ code: z.string().max(64) })).mutation(async ({ ctx, input }) => {
      const { db, capture } = await captureByCode(input.code);
      const now = new Date();
      const updated = await db.transaction(async tx => {
        // Destruir sem ter recolhido também vale (o papel chegou direto na fragmentadora): recolhimento fica marcado junto.
        const result = await tx.update(captureSheetPrints).set({ destroyedAt: now, destroyedByUserId: ctx.user.id, collectedAt: sql`COALESCE(${captureSheetPrints.collectedAt}, ${now})`, collectedByUserId: sql`COALESCE(${captureSheetPrints.collectedByUserId}, ${ctx.user.id})` }).where(and(eq(captureSheetPrints.captureId, capture.id), isNull(captureSheetPrints.destroyedAt)));
        const rows = affectedRows(result) ?? 0;
        if (rows) await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture", entityId: capture.id, action: "sheet_paper_destroyed", summary: `Ficha ${capture.id}: papel destruído (${rows} impressão(ões)). A ficha digital permanece.` });
        return rows;
      });
      if (!updated) throw new TRPCError({ code: "BAD_REQUEST", message: "Nenhuma impressão pendente de destruição." });
      return { destroyed: updated };
    }),
    /** Painel do gerente: fichas impressas no dia e ainda não recolhidas ou não destruídas, mais o alerta de reimpressão. Sem CPF nem renda. */
    outstanding: receptionProcedure.input(z.object({ date: z.string().date().optional() }).optional()).query(async ({ ctx, input }) => {
      const db = await requireDb();
      const settings = await loadSettings(db);
      const tz = projectTimezone();
      const day = input?.date ?? todayLocal();
      const start = localDayStart(day, tz, localDateInTimezone), end = localDayStart(addCalendarDays(day, 1), tz, localDateInTimezone);
      // Papel de dias anteriores que ainda não foi destruído também entra (é o atrasado); impressões do dia consultado entram sempre.
      const rows = await db.select({ id: captureSheetPrints.id, captureId: captureSheetPrints.captureId, printedAt: captureSheetPrints.printedAt, collectedAt: captureSheetPrints.collectedAt, destroyedAt: captureSheetPrints.destroyedAt, reprint: captureSheetPrints.reprint, destroyDeadlineDays: captureSheetPrints.destroyDeadlineDays, coupleCode: captureRecords.coupleCode, salesRoom: captureRecords.salesRoom, customerName: customers.fullName, checkedInAt: captureRecords.checkedInAt, scheduledAt: captureRecords.scheduledAt, createdAt: captureRecords.createdAt, commercialOutcome: captureRecords.commercialOutcome })
        .from(captureSheetPrints).innerJoin(captureRecords, eq(captureRecords.id, captureSheetPrints.captureId)).innerJoin(customers, eq(customers.id, captureRecords.customerId))
        .where(and(lt(captureSheetPrints.printedAt, end), or(gte(captureSheetPrints.printedAt, start), isNull(captureSheetPrints.destroyedAt)))).orderBy(desc(captureSheetPrints.printedAt), desc(captureSheetPrints.id)).limit(PANEL_LIMIT + 1);
      // Corte explícito: com mais linhas que o limite o painel avisa que a lista está incompleta em vez de apresentar totais parciais como completos.
      const truncated = rows.length > PANEL_LIMIT;
      if (truncated) rows.length = PANEL_LIMIT;
      const byCapture = new Map<number, typeof rows>();
      for (const row of rows) byCapture.set(row.captureId, [...(byCapture.get(row.captureId) ?? []), row]);
      // Total de impressões por ficha, sem o filtro de dia/destruição: a cópia antiga destruída em outro dia também conta.
      const captureIds = Array.from(byCapture.keys());
      const totals = captureIds.length ? await db.select({ captureId: captureSheetPrints.captureId, total: sql<number>`COUNT(*)` }).from(captureSheetPrints).where(inArray(captureSheetPrints.captureId, captureIds)).groupBy(captureSheetPrints.captureId) : [];
      const totalByCapture = new Map(totals.map(row => [row.captureId, Number(row.total)]));
      const today = todayLocal();
      const sheets = Array.from(byCapture.entries()).map(([captureId, prints]) => {
        const last = prints[0]!;
        const custody = paperCustodyOfSheet(prints.map(print => ({ printedDay: localDateInTimezone(print.printedAt, tz), collectedAt: print.collectedAt, destroyedAt: print.destroyedAt, destroyDeadlineDays: print.destroyDeadlineDays })), today, settings.paperDestroyDeadlineDays);
        // Ficha fora da vista da sala: o papel continua na lista (alguém precisa destruí-lo), mas sem o nome do casal para quem não é administrativo.
        const hidden = !canOpenArchivedSheet(ctx.user.role) && !visibilityOf(last, settings).visibleToRoom;
        return { captureId, coupleCode: last.coupleCode, customerName: hidden ? null : last.customerName, salesRoom: hidden ? null : last.salesRoom, printCount: totalByCapture.get(captureId) ?? prints.length, lastPrintedAt: last.printedAt, collectedAt: last.collectedAt, destroyedAt: last.destroyedAt, ...custody, reprintAlert: (totalByCapture.get(captureId) ?? prints.length) >= REPRINT_ALERT_THRESHOLD || prints.some(print => print.reprint) };
      });
      return {
        date: day,
        truncated,
        limit: PANEL_LIMIT,
        printed: sheets.length,
        notCollected: sheets.filter(sheet => sheet.status === "em_circulacao").length,
        notDestroyed: sheets.filter(sheet => sheet.status !== "destruida").length,
        overdue: sheets.filter(sheet => sheet.overdue).length,
        reprintAlerts: sheets.filter(sheet => sheet.reprintAlert).length,
        sheets: sheets.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.status === "destruida" ? 1 : 0) - (b.status === "destruida" ? 1 : 0)),
      };
    }),
  }),

  /**
   * Exportação CSV/Excel das fichas (decisões 34 e 48; parecer M1): CPF só com `export.pii` (admin e finance, padrão
   * confirmado pelo Lucas 17/10 16:14Z); quem não tem o administrativo só vê o que a sala vê; a trilha guarda filtros,
   * formato, com/sem CPF e número de linhas. O arquivo é montado na tela (shared/captureSheetExport.ts).
   */
  export: router({
    rows: internalProcedure.input(z.object({
      from: z.string().date(),
      to: z.string().date(),
      salesRoom: z.string().trim().max(180).optional(),
      withCpf: z.boolean().default(false),
      format: z.enum(["csv", "xlsx"]),
    })).mutation(async ({ ctx, input }) => {
      if (input.withCpf) assertCapability(ctx.user.role as never, "export.pii", "Exportar com CPF é só da administração e do financeiro.");
      if (input.to < input.from) throw new TRPCError({ code: "BAD_REQUEST", message: "O fim do período vem antes do início." });
      if (addCalendarDays(input.from, 366) < input.to) throw new TRPCError({ code: "BAD_REQUEST", message: "Exporte no máximo um ano por vez." });
      const db = await requireDb();
      const tz = projectTimezone();
      const start = localDayStart(input.from, tz, localDateInTimezone), end = localDayStart(addCalendarDays(input.to, 1), tz, localDateInTimezone);
      const limit = 5000;
      const conditions = [gte(captureRecords.createdAt, start), lt(captureRecords.createdAt, end)];
      if (input.salesRoom?.trim()) conditions.push(eq(captureRecords.salesRoom, input.salesRoom.trim()));
      if (!canOpenArchivedSheet(ctx.user.role)) conditions.push(roomVisibleCondition(await roomVisibilityCutoff())!);
      const promoter = alias(users, "promoter"), liner = alias(users, "liner"), closer = alias(users, "closer");
      const rows = await db.select({
        captureId: captureRecords.id, coupleCode: captureRecords.coupleCode, createdAt: captureRecords.createdAt, checkedInAt: captureRecords.checkedInAt, salesRoom: captureRecords.salesRoom, captureLocation: captureRecords.captureLocation,
        presentationStatus: captureRecords.presentationStatus, qualificationStatus: captureRecords.qualificationStatus, commercialOutcome: captureRecords.commercialOutcome, customerName: customers.fullName, documentNumber: customers.documentNumber, city: customers.city, state: customers.state,
        partnerName: captureRecords.partnerName, averageIncome: captureRecords.averageIncome, promoterName: promoter.name, linerName: liner.name, closerName: closer.name,
      }).from(captureRecords).innerJoin(customers, eq(customers.id, captureRecords.customerId))
        .leftJoin(promoter, eq(promoter.id, captureRecords.promoterId)).leftJoin(liner, eq(liner.id, captureRecords.linerId)).leftJoin(closer, eq(closer.id, captureRecords.closerId))
        .where(and(...conditions)).orderBy(asc(captureRecords.createdAt), asc(captureRecords.id)).limit(limit + 1);
      const truncated = rows.length > limit;
      const page: CaptureExportSource[] = rows.slice(0, limit).map(row => ({ ...row, documentNumber: input.withCpf ? row.documentNumber : null }));
      // Trilha sem dado pessoal: filtros, formato, com/sem CPF e quantas linhas saíram (parecer M1.b).
      await recordAudit(ctx.user.id, "capture_export", `${input.from}_${input.to}`, "sheet_exported", `Fichas exportadas em ${input.format.toUpperCase()}: ${page.length} linha(s)${truncated ? " (corte em " + limit + ")" : ""}, período ${input.from} a ${input.to}${input.salesRoom?.trim() ? `, sala "${input.salesRoom.trim()}"` : ""}, ${input.withCpf ? "COM CPF" : "sem CPF"}.`);
      return { rows: page, truncated, limit, timeZone: tz };
    }),
  }),

  roles: router({
    list: receptionProcedure.input(z.object({ includeInactive: z.boolean().default(false) }).optional()).query(async ({ input }) => {
      const db = await requireDb();
      const rows = await db.select().from(captureTeamRoles).orderBy(asc(captureTeamRoles.sortOrder), asc(captureTeamRoles.id)).limit(200);
      return input?.includeInactive ? rows : rows.filter(row => row.active);
    }),
    upsert: adminProcedure.input(z.object({
      id: z.number().int().positive().optional(),
      code: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,40}$/, "Use só letras minúsculas, números e _."),
      label: z.string().trim().min(2).max(120),
      kind: z.enum(["presentation", "support"]),
      sortOrder: z.number().int().min(0).max(9999).default(0),
      active: z.boolean().default(true),
    })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      try {
        await db.transaction(async tx => {
          if (input.id) await tx.update(captureTeamRoles).set({ code: input.code, label: input.label, kind: input.kind, sortOrder: input.sortOrder, active: input.active }).where(eq(captureTeamRoles.id, input.id));
          else await tx.insert(captureTeamRoles).values({ code: input.code, label: input.label, kind: input.kind, sortOrder: input.sortOrder, active: input.active });
          await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture_team_role", entityId: input.id ?? input.code, action: input.id ? "updated" : "created", summary: `Papel da equipe "${input.label}" ${input.id ? "atualizado" : "criado"}.` });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new TRPCError({ code: "CONFLICT", message: `O código "${input.code}" já existe.` });
        throw error;
      }
      return { ok: true };
    }),
  }),

  team: router({
    set: salesProcedure.input(z.object({
      captureId: z.number().int().positive(),
      roleId: z.number().int().positive(),
      userId: z.number().int().positive().optional().nullable(),
      personName: optionalName,
    })).mutation(async ({ ctx, input }) => {
      const personName = input.personName?.trim() || null;
      if (!input.userId && !personName) throw new TRPCError({ code: "BAD_REQUEST", message: "Informe a pessoa (login) ou o nome." });
      const db = await requireDb();
      const sheetSettings = await loadSettings(db);
      await db.transaction(async tx => {
        const [capture] = await tx.select({ id: captureRecords.id, checkedInAt: captureRecords.checkedInAt, scheduledAt: captureRecords.scheduledAt, createdAt: captureRecords.createdAt, commercialOutcome: captureRecords.commercialOutcome }).from(captureRecords).where(eq(captureRecords.id, input.captureId)).limit(1);
        if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
        assertSheetVisibleTo(ctx.user.role, capture, sheetSettings);
        const [role] = await tx.select({ id: captureTeamRoles.id, active: captureTeamRoles.active }).from(captureTeamRoles).where(eq(captureTeamRoles.id, input.roleId)).limit(1);
        if (!role || !role.active) throw new TRPCError({ code: "NOT_FOUND", message: "Papel da equipe não encontrado ou desativado." });
        if (input.userId) {
          const [person] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1);
          if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "Usuário não encontrado." });
        }
        await tx.insert(captureTeamMembers).values({ captureId: input.captureId, roleId: input.roleId, userId: input.userId ?? null, personName }).onDuplicateKeyUpdate({ set: { userId: input.userId ?? null, personName } });
        await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture", entityId: input.captureId, action: "team_member_set", summary: `Ficha ${input.captureId}: papel ${input.roleId} atribuído.` });
      });
      return { ok: true };
    }),
    clear: salesProcedure.input(z.object({ captureId: z.number().int().positive(), roleId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const sheetSettings = await loadSettings(db);
      await db.transaction(async tx => {
        const [capture] = await tx.select({ id: captureRecords.id, checkedInAt: captureRecords.checkedInAt, scheduledAt: captureRecords.scheduledAt, createdAt: captureRecords.createdAt, commercialOutcome: captureRecords.commercialOutcome }).from(captureRecords).where(eq(captureRecords.id, input.captureId)).limit(1);
        if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
        assertSheetVisibleTo(ctx.user.role, capture, sheetSettings);
        await tx.delete(captureTeamMembers).where(and(eq(captureTeamMembers.captureId, input.captureId), eq(captureTeamMembers.roleId, input.roleId)));
        await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture", entityId: input.captureId, action: "team_member_cleared", summary: `Ficha ${input.captureId}: papel ${input.roleId} liberado.` });
      });
      return { ok: true };
    }),
  }),
});
