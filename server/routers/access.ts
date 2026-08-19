import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "../_core/trpc";

type InternalRole = "admin" | "seller" | "finance" | "service";

function roleProcedure(allowedRoles: InternalRole[], message: string) {
  return protectedProcedure.use(({ ctx, next }) => {
    if (!allowedRoles.includes(ctx.user.role as InternalRole)) {
      throw new TRPCError({ code: "FORBIDDEN", message });
    }
    return next();
  });
}

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Apenas a administração pode executar esta ação." });
  }
  return next();
});

export const financeProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" && ctx.user.role !== "finance") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso financeiro não autorizado." });
  }
  return next();
});

export const internalProcedure = roleProcedure(["admin", "seller", "finance", "service"], "Perfil interno necessário para acessar a operação.");
export const salesProcedure = roleProcedure(["admin", "seller"], "Acesso comercial não autorizado.");
export const serviceProcedure = roleProcedure(["admin", "service"], "Acesso de atendimento/reservas não autorizado.");
export const contractsProcedure = roleProcedure(["admin", "seller", "finance", "service"], "Acesso contratual não autorizado.");
