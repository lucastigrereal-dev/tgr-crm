// F1.8 / CRM-a e CRM-b: buscar passe do GuestPass e preencher a ficha na hora. Tudo atrás de CRM_GUESTPASS_PREFILL_ENABLED (nasce false).
// Visível a admin/vendedor (salesProcedure): o prefill traz nome e telefone do casal, que a recepção já vê na ficha.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { isGuestpassPrefillEnabled, normalizePassRef, resolveGuestpassConfig } from "../guestpassConfig";
import { fetchGuestpassPrefill, findLinkByPass, findPhoneCandidates, GuestpassLinkConflict, linkGuestpassToCapture, prefillToFormFields, sanitizeFetchedAt } from "../guestpassPrefill";
import { captureRecords } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { assertCaptureInRoomView } from "./captureSheet";
import { salesProcedure } from "./access";

const passRefInput = z.string().trim().max(32).transform((value, ctx) => {
  const normalized = normalizePassRef(value);
  if (!normalized) ctx.addIssue({ code: "custom", message: "Nº do passe inválido. Use o formato GP-XXXXXXXX." });
  return normalized ?? "";
});

function requireEnabled() {
  if (!isGuestpassPrefillEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Busca de passe desligada." });
}

const failureMessage: Record<string, { code: "NOT_FOUND" | "TOO_MANY_REQUESTS" | "INTERNAL_SERVER_ERROR" | "SERVICE_UNAVAILABLE" | "BAD_GATEWAY"; message: string }> = {
  not_found: { code: "NOT_FOUND", message: "Passe não encontrado ou ainda não liberado para preencher a ficha. Preencha à mão." },
  rate_limited: { code: "TOO_MANY_REQUESTS", message: "Muitas buscas seguidas. Espere um instante e tente de novo." },
  unauthorized: { code: "INTERNAL_SERVER_ERROR", message: "O CRM não está autorizado a consultar o GuestPass. Avise a administração." },
  not_configured: { code: "SERVICE_UNAVAILABLE", message: "A ligação com o GuestPass não está configurada. Preencha à mão." },
  unavailable: { code: "SERVICE_UNAVAILABLE", message: "GuestPass indisponível agora. Preencha à mão." },
  invalid_response: { code: "BAD_GATEWAY", message: "Resposta do GuestPass fora do contrato. Preencha à mão." },
};

export const guestpassRouter = router({
  /** A tela só mostra "Buscar passe" quando isto é true. Não revela se a chave está configurada. */
  status: salesProcedure.query(() => ({ enabled: isGuestpassPrefillEnabled(), configured: resolveGuestpassConfig().enabled && (resolveGuestpassConfig() as { configured: boolean }).configured })),

  /** Busca o passe no GuestPass (pull sob demanda) e devolve os campos para preencher + fichas candidatas pelo telefone. Não grava nada. */
  lookup: salesProcedure.input(z.object({ passRef: passRefInput })).mutation(async ({ input }) => {
    requireEnabled();
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    const linked = await findLinkByPass(db, input.passRef);
    const result = await fetchGuestpassPrefill(input.passRef);
    if (result.kind !== "ok") {
      const failure = failureMessage[result.kind] ?? failureMessage.unavailable;
      throw new TRPCError({ code: failure.code, message: failure.message });
    }
    const candidates = await findPhoneCandidates(db, result.prefill.couple.phone);
    return { passRef: input.passRef, fetchedAt: new Date().toISOString(), status: result.prefill.status, fields: prefillToFormFields(result.prefill), consentVersion: result.prefill.guestPassConsentVersion ?? null, linkedCaptureId: linked?.captureId ?? null, candidates };
  }),

  /** Vincula um passe a uma ficha que já existe (candidata escolhida pela equipe). 1 passe : 1 ficha. */
  link: salesProcedure.input(z.object({ captureId: z.number().int().positive(), passRef: passRefInput, fetchedAt: z.string().datetime().optional().nullable() })).mutation(async ({ ctx, input }) => {
    requireEnabled();
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
    // Ficha inexistente = NOT_FOUND (não estoura FK em 500); ficha fora da vista da sala só para o administrativo.
    const [capture] = await db.select({ checkedInAt: captureRecords.checkedInAt, scheduledAt: captureRecords.scheduledAt, createdAt: captureRecords.createdAt, commercialOutcome: captureRecords.commercialOutcome, anonymizedAt: captureRecords.anonymizedAt }).from(captureRecords).where(eq(captureRecords.id, input.captureId)).limit(1);
    if (!capture || capture.anonymizedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha de captação não encontrada." });
    await assertCaptureInRoomView(db, ctx.user.role, capture);
    try {
      return await db.transaction(tx => linkGuestpassToCapture(tx, { captureId: input.captureId, passRef: input.passRef, actorUserId: ctx.user.id, fetchedAt: sanitizeFetchedAt(input.fetchedAt) }));
    } catch (error) {
      if (error instanceof GuestpassLinkConflict) {
        throw new TRPCError({ code: "CONFLICT", message: error.reason === "pass_taken" ? "Este passe já está vinculado a outra ficha." : "Esta ficha já tem outro passe vinculado." });
      }
      throw error;
    }
  }),
});
