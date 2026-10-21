import { TRPCError } from "@trpc/server";
import { desc, and, eq } from "drizzle-orm";
import { z } from "zod";
import { rolePermissionOverrides } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { withDeadlockRetry } from "../mysqlErrors";
import { latestPermissionOverrides, reloadPermissionOverrides, toRawOverrides } from "../permissionOverrides";
import { capabilityMatrix, EDITABLE_CAPABILITIES, FIXED_ADMIN_PATHS, getPermissionOverrides, INTERNAL_ROLES, menuPathRoles, sanitizePermissionOverrides } from "../../shared/permissions";
import { txAudit } from "../txOutbox";
import { adminProcedure } from "./access";

function requireFlag() {
  if (!ENV.permissionOverridesEnabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Permissões editáveis desligadas (PERMISSION_OVERRIDES_ENABLED)." });
}
async function requireDb() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); return db; }
const EDITABLE_PATHS = Object.keys(menuPathRoles).filter(path => !(FIXED_ADMIN_PATHS as readonly string[]).includes(path));
const scopeInput = z.object({ scope: z.enum(["capability", "menu"]), key: z.string().min(1).max(80) });
function assertEditable(scope: "capability" | "menu", key: string) {
  const ok = scope === "capability" ? (EDITABLE_CAPABILITIES as readonly string[]).includes(key) : EDITABLE_PATHS.includes(key);
  if (!ok) throw new TRPCError({ code: "FORBIDDEN", message: "Esta permissão faz parte do piso fixo e não pode ser alterada pela tela." });
}

export const permissionOverridesRouter = router({
  // Qualquer usuário logado: o navegador aplica a MESMA sanitização do servidor (o piso nunca depende do que a tela manda). Desligado: nenhuma sobrescrita.
  effective: protectedProcedure.query(() => ({ enabled: ENV.permissionOverridesEnabled, overrides: ENV.permissionOverridesEnabled ? getPermissionOverrides() : { capabilities: {}, menu: {} } })),
  list: adminProcedure.query(async () => {
    const enabled = ENV.permissionOverridesEnabled;
    let status: "off" | "ok" | "unavailable" = "off";
    let rows: Awaited<ReturnType<typeof latestPermissionOverrides>> = [];
    if (enabled) { try { rows = await latestPermissionOverrides(await requireDb()); status = "ok"; } catch { status = "unavailable"; } }
    const current = sanitizePermissionOverrides(toRawOverrides(rows));
    return {
      enabled, status, roles: INTERNAL_ROLES,
      capabilities: EDITABLE_CAPABILITIES.map(key => ({ key, defaultRoles: capabilityMatrix[key], roles: current.capabilities[key] ?? capabilityMatrix[key], overridden: Boolean(current.capabilities[key]) })),
      menu: EDITABLE_PATHS.map(key => ({ key, defaultRoles: menuPathRoles[key], roles: current.menu[key] ?? menuPathRoles[key], overridden: Boolean(current.menu[key]) })),
      fixed: { adminPaths: FIXED_ADMIN_PATHS },
    };
  }),
  history: adminProcedure.input(scopeInput).query(async ({ input }) => {
    requireFlag(); assertEditable(input.scope, input.key);
    return (await requireDb()).select().from(rolePermissionOverrides).where(and(eq(rolePermissionOverrides.scope, input.scope), eq(rolePermissionOverrides.permKey, input.key))).orderBy(desc(rolePermissionOverrides.id)).limit(200);
  }),
  set: adminProcedure.input(scopeInput.extend({ roles: z.array(z.string()).max(8) })).mutation(async ({ ctx, input }) => {
    requireFlag(); assertEditable(input.scope, input.key);
    // Piso: admin sempre presente, papéis desconhecidos fora, tela só estreita o padrão. O que é gravado já é o valor saneado.
    const clean = input.scope === "capability"
      ? sanitizePermissionOverrides({ capabilities: { [input.key]: input.roles } }).capabilities[input.key as (typeof EDITABLE_CAPABILITIES)[number]]!
      : sanitizePermissionOverrides({ menu: { [input.key]: input.roles } }).menu[input.key]!;
    const db = await requireDb();
    await withDeadlockRetry(() => db.transaction(async tx => {
      await tx.insert(rolePermissionOverrides).values({ scope: input.scope, permKey: input.key, roles: JSON.stringify(clean), createdByUserId: ctx.user.id });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "role_permission", entityId: `${input.scope}:${input.key}`, action: "permission_changed", summary: `Permissão ${input.scope === "capability" ? "da ação" : "da tela"} ${input.key}: ${clean.join(", ")}.` });
    }));
    await reloadPermissionOverrides(db);
    return { scope: input.scope, key: input.key, roles: clean };
  }),
});
