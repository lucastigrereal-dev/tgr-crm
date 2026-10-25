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
// Decisão do Lucas (25/10, "2B é a recepção mesmo"): casal que chega SEM ficha, a recepção (papel `service`) também cria o cadastro na hora, não só a sala (admin/seller).
// Atrás de RECEPTION_CAPTURE_CREATE_ENABLED, desligada por padrão: sem a flag vale a guarda de antes. Vincular o código do casal e registrar resultado seguem da sala.
export const isReceptionCaptureCreateEnabled = () => process.env.RECEPTION_CAPTURE_CREATE_ENABLED === "true";
export const captureCreateProcedure = protectedProcedure.use(({ ctx, next }) => {
  const allowed: InternalRole[] = isReceptionCaptureCreateEnabled() ? ["admin", "seller", "service"] : ["admin", "seller"];
  if (!allowed.includes(ctx.user.role as InternalRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso comercial não autorizado." });
  return next();
});
export const receptionProcedure = roleProcedure(["admin", "seller", "service"], "Acesso de recepção e sala de vendas não autorizado.");
// Item 4: lê a capacidade `commission.view` (padrão idêntico ao de antes: admin, seller, finance; editável com PERMISSION_OVERRIDES_ENABLED, admin sempre passa).
export const commissionsProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!canCapability(ctx.user.role as InternalRole, "commission.view")) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso a comissões não autorizado." });
  return next();
});
export const serviceProcedure = roleProcedure(["admin", "service"], "Acesso de atendimento/reservas não autorizado.");
export const contractsProcedure = roleProcedure(["admin", "seller", "finance", "service"], "Acesso contratual não autorizado.");
