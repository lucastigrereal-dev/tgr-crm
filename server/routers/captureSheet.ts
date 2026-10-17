import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { captureRecords, captureSheetPrints, captureSheetSettings, captureTeamMembers, captureTeamRoles, customerContacts, customers, users, vouchers } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure, receptionProcedure, salesProcedure } from "./access";
import { txAudit } from "../txOutbox";
import { DEFAULT_MIN_PRESENTATION_MINUTES, DEFAULT_NQ_SETTINGS, ageInYears, arrivalOrder, computeNq, isCoupleCode, normalizeCoupleCode, relationshipDays, type NqSettings } from "../captureSheetDomain";
import { isDuplicateKeyError } from "../mysqlErrors";
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

const SETTING_KEYS = ["nq_min_man_age", "nq_min_relationship_months", "nq_min_vehicle_year", "nq_min_income", "nq_max_items_accepted", "min_presentation_minutes", "brand_name"] as const;

const SETTING_RANGES = { nq_min_man_age: [0, 120], nq_min_relationship_months: [0, 600], nq_min_vehicle_year: [1950, 2100], nq_min_income: [0, 1_000_000], nq_max_items_accepted: [0, 7], min_presentation_minutes: [0, 600] } as const;

/** Limites provisórios gravados (ou o padrão quando a linha não existe): nada aqui é regra homologada. */
async function loadSettings(db: Awaited<ReturnType<typeof requireDb>>) {
  const rows = await db.select().from(captureSheetSettings);
  const map = new Map(rows.map(row => [row.key, row]));
  const num = (key: string, fallback: number) => { const value = Number(map.get(key)?.value); return Number.isFinite(value) && map.get(key)?.value !== "" ? value : fallback; };
  const nq: NqSettings = { minManAge: num("nq_min_man_age", DEFAULT_NQ_SETTINGS.minManAge), minRelationshipMonths: num("nq_min_relationship_months", DEFAULT_NQ_SETTINGS.minRelationshipMonths), minVehicleYear: num("nq_min_vehicle_year", DEFAULT_NQ_SETTINGS.minVehicleYear), minIncome: num("nq_min_income", DEFAULT_NQ_SETTINGS.minIncome), maxItemsAccepted: num("nq_max_items_accepted", DEFAULT_NQ_SETTINGS.maxItemsAccepted) };
  return { nq, minPresentationMinutes: num("min_presentation_minutes", DEFAULT_MIN_PRESENTATION_MINUTES), brandName: map.get("brand_name")?.value ?? "", rows };
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
    // Ficha travada na leitura e na gravação: duas ligações ao mesmo tempo não passam as duas como "primeira ligação".
    await db.transaction(async tx => {
      const [capture] = await tx.select({ id: captureRecords.id, coupleCode: captureRecords.coupleCode }).from(captureRecords).where(eq(captureRecords.id, input.captureId)).limit(1).for("update");
      if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
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
  codeOf: receptionProcedure.input(z.object({ captureId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await requireDb();
    const [capture] = await db.select({ coupleCode: captureRecords.coupleCode }).from(captureRecords).where(eq(captureRecords.id, input.captureId)).limit(1);
    if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
    return { coupleCode: capture.coupleCode };
  }),

  /** Ficha completa para a tela e a impressão. Só quem tem login e permissão chega aqui. */
  byCode: receptionProcedure.input(z.object({ code: z.string().max(64) })).query(async ({ ctx, input }) => {
    const { db, code, capture, customer } = await captureByCode(input.code);
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
    const [{ prints }] = await db.select({ prints: sql<number>`COUNT(*)` }).from(captureSheetPrints).where(eq(captureSheetPrints.captureId, capture.id));
    // Todos os contatos ativos; o que já está no cadastro principal (telefone/e-mail do cliente) não repete, mas o WhatsApp preferido, que não espelha no cadastro, entra.
    const allContacts = await db.select({ kind: customerContacts.kind, label: customerContacts.label, value: customerContacts.value }).from(customerContacts).where(and(eq(customerContacts.customerId, customer.id), isNull(customerContacts.archivedAt), sql`${customerContacts.kind} IN ('phone', 'whatsapp', 'email')`)).orderBy(desc(customerContacts.isPreferred), asc(customerContacts.id)).limit(20);
    const digits = (value?: string | null) => (value ?? "").replace(/\D/g, "");
    const contacts = allContacts.filter(contact => (contact.kind === "email" ? contact.value.trim().toLowerCase() !== (customer.email ?? "").trim().toLowerCase() : digits(contact.value) !== digits(customer.phone))).slice(0, 10);
    const gifts = await db.select({ description: vouchers.description, status: vouchers.status }).from(vouchers).where(and(eq(vouchers.captureId, capture.id), sql`${vouchers.status} <> 'cancelled'`)).orderBy(asc(vouchers.id)).limit(20);
    const settings = await loadSettings(db);
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
      const [capture] = await tx.select({ id: captureRecords.id }).from(captureRecords).where(eq(captureRecords.coupleCode, code)).limit(1).for("update");
      if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Nenhuma ficha com este código." });
      const [{ count }] = await tx.select({ count: sql<number>`COUNT(*)` }).from(captureSheetPrints).where(eq(captureSheetPrints.captureId, capture.id));
      const isReprint = Number(count) > 0;
      await tx.insert(captureSheetPrints).values({ captureId: capture.id, printedByUserId: ctx.user.id, reprint: isReprint });
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
  })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const { captureId, ...fields } = input;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      patch[key] = typeof value === "string" ? (value.trim() || null) : value;
    }
    if (patch.pepResult && patch.pepOffered === false) throw new TRPCError({ code: "BAD_REQUEST", message: "Resultado do PEP só vale quando a oferta foi feita." });
    if (!Object.keys(patch).length) return { updated: false };
    await db.transaction(async tx => {
      // Leitura e gravação juntas, com a ficha travada: duas abas não furam a regra "resultado só com oferta".
      const [existing] = await tx.select({ id: captureRecords.id, pepOffered: captureRecords.pepOffered }).from(captureRecords).where(eq(captureRecords.id, captureId)).limit(1).for("update");
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
      if (patch.pepResult && patch.pepOffered === undefined && !existing.pepOffered) throw new TRPCError({ code: "BAD_REQUEST", message: "Registre a oferta de PEP antes do resultado." });
      if (patch.pepOffered === false) { patch.pepResult = null; patch.pepOfferedBy = null; }
      await tx.update(captureRecords).set(patch).where(eq(captureRecords.id, captureId));
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture", entityId: captureId, action: "sheet_extras_updated", summary: `Ficha ${captureId}: campos da sala atualizados (${Object.keys(patch).join(", ")}).` });
    });
    return { updated: true };
  }),

  /** Limites provisórios do casal qualificado e do termo de ciência. Qualquer um da recepção lê; só a administração altera, com trilha do valor antigo e do novo. */
  settings: router({
    get: receptionProcedure.query(async () => {
      const db = await requireDb();
      const settings = await loadSettings(db);
      return { nq: settings.nq, minPresentationMinutes: settings.minPresentationMinutes, brandName: settings.brandName, provisional: true };
    }),
    set: adminProcedure.input(z.object({ key: z.enum(SETTING_KEYS), value: z.string().trim().max(255) })).mutation(async ({ ctx, input }) => {
      if (input.key !== "brand_name") {
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
      await db.transaction(async tx => {
        const [capture] = await tx.select({ id: captureRecords.id }).from(captureRecords).where(eq(captureRecords.id, input.captureId)).limit(1);
        if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
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
      await db.transaction(async tx => {
        await tx.delete(captureTeamMembers).where(and(eq(captureTeamMembers.captureId, input.captureId), eq(captureTeamMembers.roleId, input.roleId)));
        await txAudit(tx, { actorUserId: ctx.user.id, entityType: "capture", entityId: input.captureId, action: "team_member_cleared", summary: `Ficha ${input.captureId}: papel ${input.roleId} liberado.` });
      });
      return { ok: true };
    }),
  }),
});
