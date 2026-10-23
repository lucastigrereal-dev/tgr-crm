import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ENV } from "../_core/env";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { currentRetentionSettings, dismissRescueCase, listRescueCases, listRetentionHistory, listShadowDecisions, recordRescueAttempt, retentionSettingsInput, saveRetentionSettings, RETENTION_DEFAULTS } from "../rescueShadow";
import { assertCapability } from "./access";

function requireFlag() {
  if (!ENV.rescueQueueEnabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Fila de resgate desligada (RESCUE_QUEUE_ENABLED)." });
}
async function requireDb() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); return db; }
const failure = (error: "NOT_FOUND" | "NOT_OPEN") => new TRPCError(error === "NOT_FOUND" ? { code: "NOT_FOUND", message: "Caso de resgate não encontrado." } : { code: "CONFLICT", message: "Este caso já foi encerrado." });

const work = protectedProcedure.use(({ ctx, next }) => { assertCapability(ctx.user.role, "rescue.work", "Fila de resgate: acesso do pós-vendas e da administração."); return next(); });
const configure = protectedProcedure.use(({ ctx, next }) => { assertCapability(ctx.user.role, "rescue.configure", "Apenas a administração configura prazos e tetos do resgate."); return next(); });

// F3.1 (MODO SOMBRA): nada aqui cancela contrato. A configuração controla prazos, tetos e o liga/desliga do que o distrato automático FARIA (só registro).
export const rescueRouter = router({
  status: protectedProcedure.query(() => ({ enabled: ENV.rescueQueueEnabled, shadowMode: true as const, autoCancellationAvailable: false as const })),
  queue: work.query(async () => { requireFlag(); return listRescueCases(await requireDb()); }),
  attempt: work.input(z.object({ caseId: z.number().int().positive(), channel: z.enum(["phone", "message", "email", "visit", "other"]), outcome: z.enum(["no_answer", "promised_payment", "renegotiating", "refused", "other"]), note: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireFlag();
      const result = await recordRescueAttempt(await requireDb(), ctx.user.id, input);
      if (!result.ok) throw failure(result.error);
      return result;
    }),
  dismiss: work.input(z.object({ caseId: z.number().int().positive(), note: z.string().trim().min(3).max(500) })).mutation(async ({ ctx, input }) => {
    requireFlag();
    const result = await dismissRescueCase(await requireDb(), ctx.user.id, input);
    if (!result.ok) throw failure(result.error);
    return { ok: true as const };
  }),
  settings: configure.query(async () => { requireFlag(); return { current: await currentRetentionSettings(await requireDb()), defaults: RETENTION_DEFAULTS }; }),
  settingsHistory: configure.query(async () => { requireFlag(); return listRetentionHistory(await requireDb()); }),
  saveSettings: configure.input(retentionSettingsInput).mutation(async ({ ctx, input }) => { requireFlag(); return saveRetentionSettings(await requireDb(), ctx.user.id, input); }),
  shadow: configure.query(async () => { requireFlag(); return listShadowDecisions(await requireDb()); }),
});
