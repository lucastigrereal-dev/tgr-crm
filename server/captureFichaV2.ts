import { and, eq, inArray, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { captureFichaV2, customerContacts, customers } from "../drizzle/schema";

/**
 * Ficha do captador v2 (decisão do Lucas, 26/10). Só vale com CAPTURE_FICHA_V2_ENABLED=true (padrão false) e com a migration 0091 aplicada.
 * - tour_direto = visita HOJE, sem horário: não grava scheduledAt (a fila já lê ficha sem data como visita do dia e não cria tarefa de agendamento) e conta como visita explícita na regra da visita.
 * - agendamento = precisa de data e horário (scheduledAt).
 * - 2º telefone (cônjuge) vira contato do associado; idade do titular e tipo de visita ficam em capture_ficha_v2.
 * - Rascunho NÃO vem para o CRM: o GuestPass só envia ficha finalizada. CPF segue opcional na captação.
 */
export const isCaptureFichaV2Enabled = () => process.env.CAPTURE_FICHA_V2_ENABLED === "true";

export const VISIT_MODES = ["agendamento", "tour_direto"] as const;
export type VisitMode = (typeof VISIT_MODES)[number];

type FichaV2Input = { visitMode?: VisitMode | null; holderAge?: number | null; partnerPhone?: string | null; scheduledAt?: string | Date | null; isPasserby?: boolean | null };

const hasValue = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";
export const usesFichaV2 = (input: FichaV2Input) => hasValue(input.visitMode) || hasValue(input.holderAge) || hasValue(input.partnerPhone);

/** Erro da ficha v2 (nulo quando está de acordo). Chamado antes de abrir transação. */
export function fichaV2Violation(input: FichaV2Input): { code: "PRECONDITION_FAILED" | "BAD_REQUEST"; message: string } | null {
  if (!usesFichaV2(input)) return null;
  if (!isCaptureFichaV2Enabled()) return { code: "PRECONDITION_FAILED", message: "Ficha do captador v2 desligada (CAPTURE_FICHA_V2_ENABLED)." };
  const hasDate = hasValue(input.scheduledAt);
  if (input.visitMode === "tour_direto" && hasDate) return { code: "BAD_REQUEST", message: "Tour direto é a visita de hoje e não tem horário: não envie data agendada." };
  if (input.visitMode === "tour_direto" && input.isPasserby === true) return { code: "BAD_REQUEST", message: "Tour direto e passante são o mesmo caso: use só um deles." };
  if (input.visitMode === "agendamento" && !hasDate) return { code: "BAD_REQUEST", message: "Agendamento precisa de data e horário da visita." };
  return null;
}

export const fichaV2Error = (violation: NonNullable<ReturnType<typeof fichaV2Violation>>) => new TRPCError(violation);

const PARTNER_PHONE_LABEL = "Telefone do cônjuge";

/** Grava o que a v2 trouxe, na MESMA transação da ficha. 2º telefone igual ao principal ou já cadastrado não duplica. */
export async function saveFichaV2(tx: any, params: { captureId: number; customerId: number; actorUserId: number; input: FichaV2Input }) {
  const { captureId, customerId, actorUserId, input } = params;
  if (!usesFichaV2(input)) return;
  if (hasValue(input.visitMode) || hasValue(input.holderAge)) {
    await tx.insert(captureFichaV2).values({ captureId, visitMode: input.visitMode ?? null, holderAge: hasValue(input.holderAge) ? input.holderAge : null });
  }
  const phone = hasValue(input.partnerPhone) ? String(input.partnerPhone).trim() : null;
  if (!phone) return;
  const [customer] = await tx.select({ phone: customers.phone }).from(customers).where(eq(customers.id, customerId)).limit(1);
  const digits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");
  if (digits(customer?.phone) === digits(phone)) return;
  const existing: Array<{ value: string }> = await tx.select({ value: customerContacts.value }).from(customerContacts).where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.kind, "phone"), isNull(customerContacts.archivedAt)));
  if (existing.some(row => digits(row.value) === digits(phone))) return;
  await tx.insert(customerContacts).values({ customerId, kind: "phone", label: PARTNER_PHONE_LABEL, value: phone, isPreferred: false, createdByUserId: actorUserId });
}

/** Anonimização (LGPD): zera a idade do titular das fichas apagadas. Roda mesmo com a flag desligada depois; sem a 0091 aplicada (tabela inexistente, errno 1146) não há o que apagar. */
export async function eraseFichaV2(tx: any, sheetIds: number[]) {
  if (!sheetIds.length) return;
  try { await tx.update(captureFichaV2).set({ holderAge: null }).where(inArray(captureFichaV2.captureId, sheetIds)); }
  catch (error) {
    const errno = (error as { errno?: number; cause?: { errno?: number } })?.errno ?? (error as { cause?: { errno?: number } })?.cause?.errno;
    if (errno !== 1146) throw error;
  }
}
