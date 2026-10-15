import { createHash, randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { billingRecords, contracts, customers, installments, ownerPortalLinks } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { publicProcedure, router } from "../_core/trpc";
import { adminProcedure } from "./access";
import { affectedRows } from "../mysqlErrors";

/**
 * Portal do Proprietário (TSE #19, escopo mínimo): a administração gera um link de leitura para o associado e o envia pelo
 * próprio time (o sistema não manda nada para fora). O link mostra contratos, parcelas e a 2ª via das cobranças em aberto.
 * O token tem 256 bits; só o SHA-256 dele fica no banco. Expira (padrão 30 dias, máximo 90) e pode ser revogado.
 * Sem CPF, endereço, telefone ou e-mail na resposta: só o primeiro nome do associado.
 */
export const OWNER_PORTAL_MAX_DAYS = 90;
const PAYABLE_CONTRACT_STATUSES: string[] = ["pending_signature", "active", "overdue"];
const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Link inválido.");
const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] ?? "";
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Link inválido, expirado ou revogado. Peça um novo link à equipe." });

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  return db;
}

export const ownerPortalRouter = router({
  createLink: adminProcedure.input(z.object({ customerId: z.number().int().positive(), days: z.number().int().min(1).max(OWNER_PORTAL_MAX_DAYS).default(30) })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const [customer] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Associado não encontrado." });
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);
    const [created] = await db.insert(ownerPortalLinks).values({ customerId: customer.id, tokenHash: tokenHash(token), createdByUserId: ctx.user.id, expiresAt }).$returningId();
    await recordAudit(ctx.user.id, "owner_portal_link", created.id, "created", `Link do portal do associado ${customer.id}, válido por ${input.days} dia(s).`);
    // O token só aparece aqui, uma vez; depois só existe o hash.
    return { linkId: created.id, path: `/portal/${token}`, expiresAt };
  }),

  listLinks: adminProcedure.input(z.object({ customerId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await requireDb();
    const rows = await db.select({ id: ownerPortalLinks.id, expiresAt: ownerPortalLinks.expiresAt, revokedAt: ownerPortalLinks.revokedAt, lastAccessedAt: ownerPortalLinks.lastAccessedAt, accessCount: ownerPortalLinks.accessCount, createdAt: ownerPortalLinks.createdAt })
      .from(ownerPortalLinks).where(eq(ownerPortalLinks.customerId, input.customerId)).orderBy(desc(ownerPortalLinks.createdAt)).limit(20);
    const now = Date.now();
    return rows.map(row => ({ ...row, active: !row.revokedAt && row.expiresAt.getTime() > now }));
  }),

  revokeLink: adminProcedure.input(z.object({ linkId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const result = await db.update(ownerPortalLinks).set({ revokedAt: new Date(), revokedByUserId: ctx.user.id }).where(and(eq(ownerPortalLinks.id, input.linkId), isNull(ownerPortalLinks.revokedAt)));
    if (affectedRows(result) === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Link não encontrado ou já revogado." });
    await recordAudit(ctx.user.id, "owner_portal_link", input.linkId, "revoked", `Link do portal ${input.linkId} revogado.`);
    return { revoked: true };
  }),

  view: publicProcedure.input(z.object({ token: tokenSchema })).query(async ({ input }) => {
    const db = await requireDb();
    const [link] = await db.select().from(ownerPortalLinks).where(eq(ownerPortalLinks.tokenHash, tokenHash(input.token))).limit(1);
    if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now()) throw notFound();
    const [customer] = await db.select({ id: customers.id, fullName: customers.fullName }).from(customers).where(eq(customers.id, link.customerId)).limit(1);
    if (!customer) throw notFound();
    await db.update(ownerPortalLinks).set({ lastAccessedAt: new Date(), accessCount: sql`${ownerPortalLinks.accessCount} + 1` }).where(eq(ownerPortalLinks.id, link.id));

    // Rascunho não é do associado ainda: o portal mostra o que já foi para assinatura ou além.
    const contractRows = await db.select({ id: contracts.id, number: contracts.number, status: contracts.status, usageModel: contracts.usageModel, totalAmount: contracts.totalAmount, signedAt: contracts.signedAt, activatedAt: contracts.activatedAt })
      .from(contracts).where(and(eq(contracts.customerId, customer.id), inArray(contracts.status, ["pending_signature", "active", "overdue", "cancelled", "closed"]))).orderBy(asc(contracts.id));
    const contractIds = contractRows.map(row => row.id);
    const installmentRows = contractIds.length
      ? await db.select({ id: installments.id, contractId: installments.contractId, sequence: installments.sequence, dueDate: installments.dueDate, amount: installments.amount, status: installments.status, paidAt: installments.paidAt })
        .from(installments).where(inArray(installments.contractId, contractIds)).orderBy(asc(installments.contractId), asc(installments.sequence))
      : [];
    // PIX e boleto só para contrato que ainda se paga: encerrado ou cancelado continua no histórico, sem meio de pagamento.
    const payableContractIds = new Set(contractRows.filter(row => PAYABLE_CONTRACT_STATUSES.includes(row.status)).map(row => row.id));
    const openInstallmentIds = installmentRows.filter(row => payableContractIds.has(row.contractId) && (row.status === "open" || row.status === "overdue")).map(row => row.id);
    const billingRows = openInstallmentIds.length
      ? await db.select({ installmentId: billingRecords.installmentId, type: billingRecords.type, amount: billingRecords.amount, dueDate: billingRecords.dueDate, digitableLine: billingRecords.digitableLine, pixCopyPaste: billingRecords.pixCopyPaste, invoiceUrl: billingRecords.invoiceUrl, bankSlipUrl: billingRecords.bankSlipUrl })
        .from(billingRecords).where(and(inArray(billingRecords.installmentId, openInstallmentIds), eq(billingRecords.status, "generated"))).orderBy(desc(billingRecords.id))
      : [];
    const billingByInstallment = new Map<number, (typeof billingRows)[number]>();
    for (const row of billingRows) if (!billingByInstallment.has(row.installmentId)) billingByInstallment.set(row.installmentId, row);

    await recordAudit(null, "owner_portal_link", link.id, "viewed", `Portal acessado pelo link ${link.id}.`);
    return {
      firstName: firstName(customer.fullName),
      expiresAt: link.expiresAt,
      contracts: contractRows.map(contract => ({
        ...contract,
        installments: installmentRows.filter(row => row.contractId === contract.id).map(({ contractId: _contractId, ...row }) => {
          const billing = billingByInstallment.get(row.id);
          return { ...row, billing: billing ? { type: billing.type, amount: billing.amount, dueDate: billing.dueDate, digitableLine: billing.digitableLine, pixCopyPaste: billing.pixCopyPaste, invoiceUrl: billing.invoiceUrl, bankSlipUrl: billing.bankSlipUrl } : null };
        }),
      })),
    };
  }),
});
