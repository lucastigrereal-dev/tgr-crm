import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "../../drizzle/schema";
import { getDb, recordAudit } from "../db";
import { router } from "../_core/trpc";
import { adminProcedure } from "./access";

export const teamRouter = router({
  list: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select({ id: users.id, name: users.name, email: users.email, role: users.role, lastSignedIn: users.lastSignedIn, createdAt: users.createdAt })
      .from(users).orderBy(asc(users.name)).limit(500);
  }),

  updateRole: adminProcedure.input(z.object({ id: z.number().int().positive(), role: z.enum(["admin", "seller", "finance", "service", "user"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
      if (input.id === ctx.user.id && input.role !== "admin") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Você não pode remover seu próprio acesso administrativo." });
      }
      const existing = (await db.select({ id: users.id }).from(users).where(eq(users.id, input.id)).limit(1))[0];
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Usuário não encontrado." });
      await db.update(users).set({ role: input.role }).where(eq(users.id, input.id));
      await recordAudit(ctx.user.id, "user", input.id, "role_updated", `Perfil alterado para ${input.role}.`);
      return { success: true };
    }),
});
