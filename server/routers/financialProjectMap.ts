import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { financialProjectMap, resorts } from "../../drizzle/schema";
import { getDb } from "../db";
import { txAudit } from "../txOutbox";
import { router } from "../_core/trpc";
import { adminProcedure } from "./access";

/** CRM-A01: administra o mapa empreendimento -> projeto do Financial. O mapa só tem efeito com FINANCIAL_PROJECT_MAP_ENABLED=true (padrão false). */
export const financialProjectMapRouter = router({
  list: adminProcedure.query(async () => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const rows = await db.select({ map: financialProjectMap, resortName: resorts.name }).from(financialProjectMap).innerJoin(resorts, eq(resorts.id, financialProjectMap.resortId)).orderBy(asc(resorts.name));
    return { enabled: process.env.FINANCIAL_PROJECT_MAP_ENABLED === "true", rows: rows.map(row => ({ ...row.map, resortName: row.resortName })) };
  }),
  set: adminProcedure.input(z.object({
    resortId: z.number().int().positive(),
    externalKey: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/, "Use letras, números, ponto, hífen ou sublinhado (até 64)."),
    name: z.string().trim().min(2).max(160),
    timezone: z.string().trim().min(3).max(64).default("America/Recife"),
    active: z.boolean().default(true),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    try { new Intl.DateTimeFormat("pt-BR", { timeZone: input.timezone }); } catch { throw new TRPCError({ code: "BAD_REQUEST", message: "Fuso horário inválido." }); }
    await db.transaction(async tx => {
      const resort = (await tx.select({ id: resorts.id }).from(resorts).where(eq(resorts.id, input.resortId)).limit(1))[0];
      if (!resort) throw new TRPCError({ code: "NOT_FOUND", message: "Empreendimento não encontrado." });
      await tx.insert(financialProjectMap).values(input).onDuplicateKeyUpdate({ set: { externalKey: input.externalKey, name: input.name, timezone: input.timezone, active: input.active } });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "financial_project_map", entityId: input.resortId, action: "set", summary: `Empreendimento ${input.resortId} mapeado ao projeto ${input.externalKey} do Financial (${input.active ? "ativo" : "inativo"}).` });
    });
    return { resortId: input.resortId };
  }),
  remove: adminProcedure.input(z.object({ resortId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    await db.transaction(async tx => {
      await tx.delete(financialProjectMap).where(eq(financialProjectMap.resortId, input.resortId));
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "financial_project_map", entityId: input.resortId, action: "removed", summary: `Mapa do empreendimento ${input.resortId} removido; volta ao projeto padrão.` });
    });
    return { resortId: input.resortId };
  }),
});
