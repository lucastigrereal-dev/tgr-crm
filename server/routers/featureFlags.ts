import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { featureFlagOverrides } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { router } from "../_core/trpc";
import { getDb } from "../db";
import { applyOverrideLive, bootValueOf, effectiveValueOf, FLAG_ALLOWLIST, FLAG_KEYS, isAllowedFlag, latestOverrides } from "../featureFlags";
import { withDeadlockRetry } from "../mysqlErrors";
import { txAudit } from "../txOutbox";
import { adminProcedure } from "./access";

function requireMaster() {
  if (!ENV.featureFlagOverridesEnabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Tela de flags desligada (FEATURE_FLAG_OVERRIDES_ENABLED)." });
}
async function requireDb() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); return db; }

// Item 6: só admin. Só a allow-list; COMMISSION_V2_RELEASED e flags de segurança/auth/chave são recusadas (deny-list em featureFlags.ts).
export const featureFlagsRouter = router({
  list: adminProcedure.query(async () => {
    const overridesEnabled = ENV.featureFlagOverridesEnabled;
    const overrides = overridesEnabled ? await latestOverrides(await requireDb()).catch(() => null) : null;
    return {
      overridesEnabled,
      flags: FLAG_KEYS.map(key => {
        const override = overrides?.get(key) ?? null;
        const effective = effectiveValueOf(key);
        const configured = override ? override.enabled : bootValueOf(key);
        return { key, label: FLAG_ALLOWLIST[key].label, restartRequired: FLAG_ALLOWLIST[key].restartRequired, bootValue: bootValueOf(key), effective, override, pendingRestart: FLAG_ALLOWLIST[key].restartRequired && configured !== effective };
      }),
    };
  }),
  history: adminProcedure.input(z.object({ key: z.string() })).query(async ({ input }) => {
    requireMaster();
    if (!isAllowedFlag(input.key)) throw new TRPCError({ code: "BAD_REQUEST", message: "Esta flag não pode ser consultada nem alterada pela tela." });
    return (await requireDb()).select().from(featureFlagOverrides).where(eq(featureFlagOverrides.flagKey, input.key)).orderBy(desc(featureFlagOverrides.id)).limit(200);
  }),
  set: adminProcedure.input(z.object({ key: z.string(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    requireMaster();
    if (!isAllowedFlag(input.key)) throw new TRPCError({ code: "FORBIDDEN", message: "Esta flag não pode ser alterada pela tela (fora da allow-list)." });
    const key = input.key;
    const db = await requireDb();
    await withDeadlockRetry(() => db.transaction(async tx => {
      await tx.insert(featureFlagOverrides).values({ flagKey: key, enabled: input.enabled, createdByUserId: ctx.user.id });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "feature_flag", entityId: key, action: input.enabled ? "flag_enabled" : "flag_disabled", summary: `Flag ${key} ${input.enabled ? "LIGADA" : "DESLIGADA"} pela tela${FLAG_ALLOWLIST[key].restartRequired ? " (vale após reiniciar o serviço)" : ""}.` });
    }));
    applyOverrideLive(key, input.enabled);
    return { key, enabled: input.enabled, restartRequired: FLAG_ALLOWLIST[key].restartRequired };
  }),
});
