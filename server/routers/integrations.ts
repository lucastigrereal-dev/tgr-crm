import { TRPCError } from "@trpc/server";
import { desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { domainEvents } from "../../drizzle/schema";
import { domainEventCatalog, isKnownDomainEvent } from "../../shared/domainEvents";
import { integrationContractVersion, toIntegrationEvent } from "../../shared/integrationContract";
import { router } from "../_core/trpc";
import { getDb } from "../db";
import { integrationHealth } from "../integrationHealth";
import { resendRejectedReceipt } from "../integrationResend";
import { adminProcedure } from "./access";

const feedInput = z.object({ limit: z.number().int().min(1).max(100).default(50), eventNames: z.array(z.string().refine(isKnownDomainEvent, "Evento desconhecido.")).max(20).optional() });

export const integrationsRouter = router({
  // Painel de falhas (TSE #34): entregues, recusados e pendentes de cada ponte, sem escrever nada.
  health: adminProcedure.query(() => integrationHealth()),
  // Reenviar um recusado (CRM-A25): troca a chave do recibo (a recusa fica na trilha), registra quem pediu e manda a ponte reler.
  resend: adminProcedure.input(z.object({ receiptId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    return resendRejectedReceipt(db, { receiptId: input.receiptId, actorUserId: ctx.user.id });
  }),
  contract: adminProcedure.query(() => ({ version: integrationContractVersion, events: Object.entries(domainEventCatalog).map(([eventName, definition]) => ({ eventName, ...definition })) })),
  eventFeed: adminProcedure.input(feedInput).query(async ({ input }) => {
    const db = await getDb(); if (!db) return { contractVersion: integrationContractVersion, events: [] };
    const rows = await db.select().from(domainEvents).where(input.eventNames?.length ? inArray(domainEvents.eventName, input.eventNames) : undefined).orderBy(desc(domainEvents.id)).limit(input.limit);
    return { contractVersion: integrationContractVersion, events: rows.flatMap(row => {
      if (!isKnownDomainEvent(row.eventName)) return [];
      return [toIntegrationEvent({ ...row, eventName: row.eventName })];
    }) };
  }),
});
