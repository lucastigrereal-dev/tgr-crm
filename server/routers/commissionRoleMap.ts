import { TRPCError } from "@trpc/server";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { commissionRoleMapVersions } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { router } from "../_core/trpc";
import { DEFAULT_COMMISSION_V2_ROLE_MAP, COMMISSION_STORED_ROLES, COMMISSION_V2_RULE_ROLES, parseCommissionRoleMap } from "../commissionRoleMap";
import { getDb } from "../db";
import { withDeadlockRetry } from "../mysqlErrors";
import { txAudit } from "../txOutbox";
import { adminProcedure } from "./access";

function requireFlag() {
  if (!ENV.commissionRoleMapEnabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Mapa de papéis da comissão desligado (COMMISSION_ROLE_MAP_ENABLED)." });
}
async function requireDb() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." }); return db; }

// Item 5: só admin; versionado; contratos em andamento mantêm o mapa que fixaram (snapshot). Não liga nem desliga o V2 (COMMISSION_V2_RELEASED é fora daqui).
export const commissionRoleMapRouter = router({
  current: adminProcedure.query(async () => {
    requireFlag();
    const db = await requireDb();
    const [row] = await db.select().from(commissionRoleMapVersions).orderBy(desc(commissionRoleMapVersions.version)).limit(1);
    let parsed = null; try { parsed = row ? parseCommissionRoleMap(JSON.parse(row.roleMap)) : null; } catch { parsed = null; }
    return { version: row?.version ?? 0, isDefault: !parsed, roleMap: parsed ?? DEFAULT_COMMISSION_V2_ROLE_MAP, ruleRoles: COMMISSION_V2_RULE_ROLES, storedRoles: COMMISSION_STORED_ROLES };
  }),
  history: adminProcedure.query(async () => {
    requireFlag();
    const db = await requireDb();
    return db.select().from(commissionRoleMapVersions).orderBy(desc(commissionRoleMapVersions.version)).limit(200);
  }),
  save: adminProcedure.input(z.object({ roleMap: z.record(z.string(), z.string()) })).mutation(async ({ ctx, input }) => {
    requireFlag();
    const roleMap = parseCommissionRoleMap(input.roleMap);
    if (!roleMap) throw new TRPCError({ code: "BAD_REQUEST", message: "Mapa inválido: informe captador, consultor e fechador, cada um para um papel diferente (promoter, liner ou closer)." });
    const db = await requireDb();
    return withDeadlockRetry(() => db.transaction(async tx => {
      const [last] = await tx.select({ version: commissionRoleMapVersions.version }).from(commissionRoleMapVersions).orderBy(desc(commissionRoleMapVersions.version)).limit(1).for("update");
      const version = (last?.version ?? 0) + 1;
      await tx.insert(commissionRoleMapVersions).values({ version, roleMap: JSON.stringify(roleMap), createdByUserId: ctx.user.id });
      await txAudit(tx, { actorUserId: ctx.user.id, entityType: "commission_role_map", entityId: version, action: "version_saved", summary: `Mapa de papéis da comissão: versão ${version} (${COMMISSION_V2_RULE_ROLES.map(role => `${role}=${roleMap[role]}`).join(", ")}). Vale só para contratos novos.` });
      return { version, roleMap };
    }));
  }),
});
