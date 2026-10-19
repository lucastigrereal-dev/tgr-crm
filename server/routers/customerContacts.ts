import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { customerContacts, customers } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { anonymizedCustomerError } from "../customerAnonymization";
import { internalProcedure } from "./access";
import { affectedRows } from "../mysqlErrors";

/**
 * Contatos adicionais do associado (TSE #28): vários telefones, WhatsApp, e-mails e endereços, com um preferencial por tipo.
 * O preferencial de telefone e e-mail é copiado para customers.phone/email, o contato principal que cobrança, radar e
 * listas já usam. Arquivar não apaga: o contato sai da lista e o histórico fica.
 */
type Kind = "phone" | "whatsapp" | "email" | "address";
const kindLabel: Record<Kind, string> = { phone: "telefone", whatsapp: "WhatsApp", email: "e-mail", address: "endereço" };
const digits = (value: string) => value.replace(/\D/g, "");
/** Chave de comparação para barrar o mesmo contato duas vezes. */
export const contactKey = (kind: Kind, value: string) => kind === "phone" || kind === "whatsapp" ? digits(value) : value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");

const contactInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["phone", "whatsapp"]), value: z.string().trim().max(32).refine(value => /^\+?[\d\s().-]+$/.test(value) && digits(value).length >= 8 && digits(value).length <= 15, "Telefone: de 8 a 15 dígitos.") }),
  z.object({ kind: z.literal("email"), value: z.string().trim().toLowerCase().email("E-mail inválido.").max(320) }),
  z.object({ kind: z.literal("address"), value: z.string().trim().min(5, "Endereço muito curto.").max(500) }),
]);

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  return db;
}
type Db = Awaited<ReturnType<typeof requireDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type PrimaryKind = "phone" | "email";

/**
 * Quando o cadastro principal (customers.phone/email) muda pela edição da ficha, o preferencial dos contatos acompanha:
 * se o novo valor já está na lista ele vira o preferencial; se a lista já está em uso, o novo valor entra nela como
 * preferencial; valor vazio deixa o tipo sem preferencial. Sem contatos daquele tipo, nada a fazer (o cadastro basta).
 */
export async function syncPreferredFromProfile(tx: Tx, customerId: number, kind: PrimaryKind, value: string | null, actorUserId: number) {
  const active = await tx.select({ id: customerContacts.id, value: customerContacts.value }).from(customerContacts)
    .where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.kind, kind), isNull(customerContacts.archivedAt)));
  if (!active.length) return;
  await tx.update(customerContacts).set({ isPreferred: false }).where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.kind, kind)));
  if (!value) return;
  const key = contactKey(kind, value);
  const match = active.find(row => contactKey(kind, row.value) === key);
  if (match) await tx.update(customerContacts).set({ isPreferred: true }).where(eq(customerContacts.id, match.id));
  else await tx.insert(customerContacts).values({ customerId, kind, value, isPreferred: true, createdByUserId: actorUserId });
}

/** Marca o contato como preferencial do tipo e, para telefone e e-mail, espelha no cadastro principal. */
async function makePreferred(tx: Tx, contact: { id: number; customerId: number; kind: Kind; value: string }) {
  await tx.update(customerContacts).set({ isPreferred: false })
    .where(and(eq(customerContacts.customerId, contact.customerId), eq(customerContacts.kind, contact.kind), ne(customerContacts.id, contact.id)));
  await tx.update(customerContacts).set({ isPreferred: true }).where(eq(customerContacts.id, contact.id));
  if (contact.kind === "phone") await tx.update(customers).set({ phone: contact.value }).where(eq(customers.id, contact.customerId));
  if (contact.kind === "email") await tx.update(customers).set({ email: contact.value }).where(eq(customers.id, contact.customerId));
}

/**
 * Trava o associado e depois o contato, na mesma ordem do add: duas mutações no mesmo associado ficam em fila e nunca
 * deixam dois preferenciais do mesmo tipo.
 */
async function lockContact(tx: Tx, contactId: number) {
  const [owner] = await tx.select({ customerId: customerContacts.customerId }).from(customerContacts).where(eq(customerContacts.id, contactId)).limit(1);
  if (!owner) return undefined;
  await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, owner.customerId)).limit(1).for("update");
  const [row] = await tx.select().from(customerContacts).where(eq(customerContacts.id, contactId)).limit(1).for("update");
  return row;
}

export const customerContactsRouter = router({
  list: internalProcedure.input(z.object({ customerId: z.number().int().positive(), includeArchived: z.boolean().default(false) })).query(async ({ input }) => {
    const db = await requireDb();
    const filter = input.includeArchived ? eq(customerContacts.customerId, input.customerId) : and(eq(customerContacts.customerId, input.customerId), isNull(customerContacts.archivedAt));
    return db.select({ id: customerContacts.id, kind: customerContacts.kind, label: customerContacts.label, value: customerContacts.value, isPreferred: customerContacts.isPreferred, archivedAt: customerContacts.archivedAt, createdAt: customerContacts.createdAt })
      .from(customerContacts).where(filter).orderBy(asc(customerContacts.kind), desc(customerContacts.isPreferred), asc(customerContacts.id)).limit(200);
  }),

  add: internalProcedure.input(z.object({ customerId: z.number().int().positive(), label: z.string().trim().max(60).optional(), preferred: z.boolean().default(false) }).and(contactInput)).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const id = await db.transaction(async tx => {
      const [customer] = await tx.select({ id: customers.id, phone: customers.phone, email: customers.email, anonymizedAt: customers.anonymizedAt }).from(customers).where(eq(customers.id, input.customerId)).limit(1).for("update");
      if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Associado não encontrado." });
      if (customer.anonymizedAt) throw anonymizedCustomerError();
      const activeOf = () => tx.select({ id: customerContacts.id, value: customerContacts.value, isPreferred: customerContacts.isPreferred }).from(customerContacts)
        .where(and(eq(customerContacts.customerId, customer.id), eq(customerContacts.kind, input.kind), isNull(customerContacts.archivedAt)));
      let active = await activeOf();
      // Ficha anterior aos contatos: o telefone/e-mail principal entra na lista como preferencial antes do novo, para não ser sobrescrito.
      const legacy = input.kind === "phone" ? customer.phone : input.kind === "email" ? customer.email : null;
      if (legacy && !active.some(row => row.isPreferred)) {
        if (!active.some(row => contactKey(input.kind, row.value) === contactKey(input.kind, legacy))) await tx.insert(customerContacts).values({ customerId: customer.id, kind: input.kind, value: legacy, label: "principal", isPreferred: true, createdByUserId: ctx.user.id });
        else await syncPreferredFromProfile(tx, customer.id, input.kind as PrimaryKind, legacy, ctx.user.id);
        active = await activeOf();
      }
      const key = contactKey(input.kind, input.value);
      if (active.some(row => contactKey(input.kind, row.value) === key)) throw new TRPCError({ code: "CONFLICT", message: `Este ${kindLabel[input.kind]} já está na ficha.` });
      const [created] = await tx.insert(customerContacts).values({ customerId: customer.id, kind: input.kind, label: input.label || null, value: input.value, createdByUserId: ctx.user.id }).$returningId();
      // O primeiro contato do tipo já nasce preferencial.
      if (input.preferred || !active.some(row => row.isPreferred)) await makePreferred(tx, { id: created.id, customerId: customer.id, kind: input.kind, value: input.value });
      return created.id;
    });
    await recordAudit(ctx.user.id, "customer_contact", id, "created", `Novo ${kindLabel[input.kind]} na ficha do associado ${input.customerId}.`);
    return { contactId: id };
  }),

  setPreferred: internalProcedure.input(z.object({ contactId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const contact = await db.transaction(async tx => {
      const row = await lockContact(tx, input.contactId);
      if (!row || row.archivedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Contato não encontrado ou arquivado." });
      await makePreferred(tx, row);
      return row;
    });
    await recordAudit(ctx.user.id, "customer_contact", contact.id, "preferred", `${kindLabel[contact.kind]} preferencial do associado ${contact.customerId} alterado.`);
    return { success: true };
  }),

  archive: internalProcedure.input(z.object({ contactId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const row = await db.transaction(async tx => {
      const contact = await lockContact(tx, input.contactId);
      if (!contact) throw new TRPCError({ code: "NOT_FOUND", message: "Contato não encontrado." });
      const result = await tx.update(customerContacts).set({ archivedAt: new Date(), archivedByUserId: ctx.user.id, isPreferred: false })
        .where(and(eq(customerContacts.id, input.contactId), isNull(customerContacts.archivedAt)));
      if (affectedRows(result) === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Contato já arquivado." });
      // Arquivou o preferencial: o contato mais recente que sobrou assume; sem nenhum, o principal da ficha fica vazio.
      // Leitura com trava: o lockContact leu o dono sem trava antes de esperar o associado, e o snapshot daquela leitura
      // não enxerga o que a transação da frente gravou (contato novo, outro arquivado).
      if (contact.isPreferred) {
        const [next] = await tx.select().from(customerContacts)
          .where(and(eq(customerContacts.customerId, contact.customerId), eq(customerContacts.kind, contact.kind), isNull(customerContacts.archivedAt)))
          .orderBy(desc(customerContacts.id)).limit(1).for("update");
        if (next) await makePreferred(tx, next);
        else if (contact.kind === "phone") await tx.update(customers).set({ phone: null }).where(eq(customers.id, contact.customerId));
        else if (contact.kind === "email") await tx.update(customers).set({ email: null }).where(eq(customers.id, contact.customerId));
      }
      return contact;
    });
    await recordAudit(ctx.user.id, "customer_contact", row.id, "archived", `${kindLabel[row.kind]} arquivado na ficha do associado ${row.customerId}.`);
    return { archived: true };
  }),
});
