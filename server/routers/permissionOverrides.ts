import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { rolePermissionOverrides } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { withDeadlockRetry } from "../mysqlErrors";
import { latestPermissionOverrides, reloadPermissionOverrides, toRawOverrides } from "../permissionOverrides";
import { capabilityMatrix, EDITABLE_CAPABILITIES, getPermissionOverrides, INTERNAL_ROLES, sanitizePermissionOverrides } from "../../shared/permissions";
import { txAudit } from "../txOutbox";
import { adminProcedure } from "./access";

function requireFlag() {
  if (!ENV.permissionOverridesEnabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Permissões editáveis desligadas (PERMISSION_OVERRIDES_ENABLED)." });
}
async function requireDb() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); return db; }
type EditableKey = (typeof EDITABLE_CAPABILITIES)[number];
function assertEditable(key: string): asserts key is EditableKey {
  if (!(EDITABLE_CAPABILITIES as readonly string[]).includes(key)) throw new TRPCError({ code: "FORBIDDEN", message: "Esta permissão faz parte do piso fixo e não pode ser alterada pela tela." });
}

// Item 4: por AÇÃO (capacidade). Telas ficam fixas por enquanto (esconder menu não fecha rota nem API).
export const permissionOverridesRouter = router({
  // Qualquer usuário logado: o navegador aplica a MESMA sanitização do servidor. Desligado: nenhuma sobrescrita.
  effective: protectedProcedure.query(() => ({ enabled: ENV.permissionOverridesEnabled, overrides: ENV.permissionOverridesEnabled ? getPermissionOverrides() : { capabilities: {} } })),
  list: adminProcedure.query(async () => {
    const enabled = ENV.permissionOverridesEnabled;
    let status: "off" | "ok" | "unavailable" = "off";
    let rows: Awaited<ReturnType<typeof latestPermissionOverrides>> = [];
    if (enabled) { try { rows = await latestPermissionOverrides(await requireDb()); status = "ok"; } catch { status = "unavailable"; } }
    const current = sanitizePermissionOverrides(toRawOverrides(rows));
    return {
      enabled, status, roles: INTERNAL_ROLES,
      capabilities: EDITABLE_CAPABILITIES.map(key => ({ key, defaultRoles: capabilityMatrix[key], roles: current.capabilities[key] ?? capabilityMatrix[key], overridden: Boolean(current.capabilities[key]) })),
    };
  }),
  history: adminProcedure.input(z.object({ key: z.string().min(1).max(80) })).query(async ({ input }) => {
    requireFlag(); assertEditable(input.key);
    return (await requireDb()).select().from(rolePermissionOverrides).where(and(eq(rolePermissionOverrides.permKey, input.key))).orderBy(desc(rolePermissionOverrides.id)).limit(200);
  }),
  set: adminProcedure.input(z.object({ key: z.string().min(1).max(80), roles: z.array(z.string()).max(8) })).mutation(async ({ ctx, input }) => {
    requireFlag(); assertEditable(input.key);
    // Piso: admin sempre presente, papéis desconhecidos fora. O que é gravado já é o valor saneado.
    const clean = sanitizePermissionOverrides({ capabilities: { [input.key]: input.roles } }).capabilities[input.key]!;
    const db = await requireDb();
    await withDeadlockRetry(() => db.transaction(async tx => {
      await tx.insert(rolePermissionOverrides).values({ permKey: input.key, roles: JSON.stringify(clean), createdByUserId: ctx.user.id });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "role_permission", entityId: input.key, action: "permission_changed", summary: `Permissão da ação ${input.key}: ${clean.join(", ")}.` });
    }));
    await reloadPermissionOverrides(db);
    return { key: input.key, roles: clean };
  }),
});
