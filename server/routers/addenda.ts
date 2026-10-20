import { TRPCError } from "@trpc/server";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { contractAddenda, contractDocuments, contracts, customers } from "../../drizzle/schema";
import { getDb } from "../db";
import { txAudit } from "../txOutbox";
import { router } from "../_core/trpc";
import { adminProcedure, financeProcedure } from "./access";
import { assertCustomerNotAnonymized } from "../customerAnonymization";
import { syncPreferredFromProfile } from "./customerContacts";

/**
 * CRM-A12 / ADR-012: aditivo contratual NÃO monetário, mínimo. Desligado por padrão (CONTRACT_ADDENDUM_ENABLED=true liga).
 * Fluxo: draft -> awaiting_signature -> signed | cancelled. Só `signed` produz efeito, e só com documento de categoria "Aditivo" realmente assinado
 * (signedArtifact). Valor, parcela, desconto e comissão NUNCA passam por aqui (o schema recusa campo desconhecido) e nenhum evento sai para outro sistema.
 */
export const isContractAddendumEnabled = () => process.env.CONTRACT_ADDENDUM_ENABLED === "true";
const assertEnabled = () => { if (!isContractAddendumEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Aditivo contratual está desligado neste ambiente." }); };

const contactFields = z.strictObject({ phone: z.string().trim().min(8).max(32).optional(), email: z.string().trim().email().max(255).optional() }).refine(value => value.phone !== undefined || value.email !== undefined, "Informe telefone ou e-mail.");
const createInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("clause"), contractId: z.number().int().positive(), reason: z.string().trim().min(5).max(2000), text: z.string().trim().min(3).max(4000) }),
  z.strictObject({ kind: z.literal("contact"), contractId: z.number().int().positive(), reason: z.string().trim().min(5).max(2000), after: contactFields }),
]);

const closedContractStatuses = ["cancelled", "closed"];

export const addendaRouter = router({
  enabled: financeProcedure.query(() => ({ enabled: isContractAddendumEnabled() })),

  list: financeProcedure.input(z.object({ contractId: z.number().int().positive() })).query(async ({ input }) => {
    assertEnabled();
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    return { rows: await db.select().from(contractAddenda).where(eq(contractAddenda.contractId, input.contractId)).orderBy(desc(contractAddenda.id)) };
  }),

  create: financeProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    assertEnabled();
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    return db.transaction(async tx => {
      const row = (await tx.select({ id: contracts.id, status: contracts.status, customerId: contracts.customerId }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for("update"))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato não encontrado." });
      if (closedContractStatuses.includes(row.status)) throw new TRPCError({ code: "CONFLICT", message: "Contrato cancelado ou encerrado não aceita aditivo." });
      let payload: Record<string, unknown>;
      if (input.kind === "clause") payload = { text: input.text };
      else {
        const customer = (await tx.select({ phone: customers.phone, email: customers.email }).from(customers).where(eq(customers.id, row.customerId)).limit(1))[0];
        payload = { before: { phone: input.after.phone !== undefined ? customer?.phone ?? null : undefined, email: input.after.email !== undefined ? customer?.email ?? null : undefined }, after: input.after };
      }
      const created = await tx.insert(contractAddenda).values({ contractId: row.id, kind: input.kind, reason: input.reason, payload: JSON.stringify(payload), requestedByUserId: ctx.user.id }).$returningId();
      const id = created[0]!.id;
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "contract_addendum", entityId: id, action: "created", summary: `Aditivo ${input.kind} proposto para o contrato ${row.id}.` });
      return { id };
    });
  }),

  requestSignature: financeProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    assertEnabled();
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.transaction(async tx => {
      const row = (await tx.select().from(contractAddenda).where(eq(contractAddenda.id, input.id)).limit(1).for("update"))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Aditivo não encontrado." });
      if (row.status !== "draft") throw new TRPCError({ code: "CONFLICT", message: "Só um rascunho vai para assinatura." });
      await tx.update(contractAddenda).set({ status: "awaiting_signature" }).where(eq(contractAddenda.id, row.id));
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "contract_addendum", entityId: row.id, action: "awaiting_signature", summary: "Aditivo enviado para assinatura." });
    });
    return { id: input.id, status: "awaiting_signature" as const };
  }),

  // Aprovação da administração: vincula o documento ASSINADO e aplica o efeito na mesma transação. Antes disso, nada do contrato muda.
  attachSigned: adminProcedure.input(z.object({ id: z.number().int().positive(), documentId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    assertEnabled();
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    return db.transaction(async tx => {
      const row = (await tx.select().from(contractAddenda).where(eq(contractAddenda.id, input.id)).limit(1).for("update"))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Aditivo não encontrado." });
      if (row.status !== "awaiting_signature") throw new TRPCError({ code: "CONFLICT", message: "O aditivo precisa estar aguardando assinatura." });
      const document = (await tx.select().from(contractDocuments).where(and(eq(contractDocuments.id, input.documentId), eq(contractDocuments.contractId, row.contractId))).limit(1))[0];
      if (!document || document.category !== "Aditivo" || !document.signed || !document.signedArtifact) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Vincule o documento de categoria Aditivo, assinado e com o arquivo assinado armazenado." });
      const alreadyUsed = (await tx.select({ id: contractAddenda.id }).from(contractAddenda).where(and(eq(contractAddenda.signedDocumentId, document.id), ne(contractAddenda.id, row.id))).limit(1))[0];
      if (alreadyUsed) throw new TRPCError({ code: "CONFLICT", message: `Este documento assinado já comprova o aditivo ${alreadyUsed.id}. Cada aditivo precisa do seu próprio documento.` });
      const contract = (await tx.select({ id: contracts.id, status: contracts.status, customerId: contracts.customerId }).from(contracts).where(eq(contracts.id, row.contractId)).limit(1).for("update"))[0];
      if (!contract || closedContractStatuses.includes(contract.status)) throw new TRPCError({ code: "CONFLICT", message: "Contrato cancelado ou encerrado não aceita aditivo." });
      await assertCustomerNotAnonymized(tx, contract.customerId, { lock: true });
      const payload = JSON.parse(row.payload) as { after?: { phone?: string; email?: string } };
      if (row.kind === "contact" && payload.after) {
        await tx.update(customers).set({ ...(payload.after.phone !== undefined ? { phone: payload.after.phone } : {}), ...(payload.after.email !== undefined ? { email: payload.after.email } : {}) }).where(eq(customers.id, contract.customerId));
        // Mantém a lista de contatos coerente com o cadastro principal, na mesma transação (mesma regra da edição do associado).
        if (payload.after.phone !== undefined) await syncPreferredFromProfile(tx, contract.customerId, "phone", payload.after.phone, ctx.user.id);
        if (payload.after.email !== undefined) await syncPreferredFromProfile(tx, contract.customerId, "email", payload.after.email, ctx.user.id);
      }
      await tx.update(contractAddenda).set({ status: "signed", signedDocumentId: document.id, decidedByUserId: ctx.user.id, decidedAt: new Date() }).where(eq(contractAddenda.id, row.id));
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "contract_addendum", entityId: row.id, action: "signed", summary: `Aditivo ${row.kind} assinado e aplicado ao contrato ${row.contractId}.${row.kind === "contact" ? ` Antes/depois: ${row.payload}` : ""}` });
      return { id: row.id, status: "signed" as const };
    });
  }),

  cancel: financeProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    assertEnabled();
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.transaction(async tx => {
      const row = (await tx.select().from(contractAddenda).where(eq(contractAddenda.id, input.id)).limit(1).for("update"))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Aditivo não encontrado." });
      if (!["draft", "awaiting_signature"].includes(row.status)) throw new TRPCError({ code: "CONFLICT", message: "Aditivo assinado ou cancelado não pode ser cancelado." });
      await tx.update(contractAddenda).set({ status: "cancelled", decidedByUserId: ctx.user.id, decidedAt: new Date() }).where(eq(contractAddenda.id, row.id));
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "contract_addendum", entityId: row.id, action: "cancelled", summary: "Aditivo cancelado sem efeito." });
    });
    return { id: input.id, status: "cancelled" as const };
  }),
});
