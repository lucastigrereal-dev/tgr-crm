import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "../_core/trpc";
import { canCapability, type Capability, type InternalPermissionRole } from "../permissions";

type InternalRole = InternalPermissionRole | "user";

export function assertCapability(role: InternalRole, capability: Capability, message = "Ação não autorizada para este perfil.") {
  if (!canCapability(role, capability)) throw new TRPCError({ code: "FORBIDDEN", message });
}

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
export const receptionProcedure = roleProcedure(["admin", "seller", "service"], "Acesso de recepção e sala de vendas não autorizado.");
export const commissionsProcedure = roleProcedure(["admin", "seller", "finance"], "Acesso a comissões não autorizado.");
export const serviceProcedure = roleProcedure(["admin", "service"], "Acesso de atendimento/reservas não autorizado.");
export const contractsProcedure = roleProcedure(["admin", "seller", "finance", "service"], "Acesso contratual não autorizado.");
