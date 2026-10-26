// F1.8 / CRM-b: aplica os campos do prefill do GuestPass na ficha SEM apagar o que a equipe já digitou (só preenche campo vazio).
export type GuestpassFields = { fullName: string; partnerName: string; phone: string; city: string; state: string; lodgingLocation: string; captureLocation: string; visitDate: string | null; visitMode?: string; visitTime?: string; partnerPhone?: string; holderAge?: string };

const KEYS = ["fullName", "partnerName", "phone", "city", "state", "lodgingLocation", "captureLocation"] as const;

const V2_KEYS = ["visitMode", "partnerPhone", "holderAge"] as const;

/** `fichaV2` = flag do servidor (captures.visitRule.fichaV2): só com ela ligada os campos novos entram; desligada, a ficha fica exatamente como antes. */
export function applyGuestpassFields<T extends Record<string, unknown>>(form: T, fields: GuestpassFields, blankForm: T, fichaV2 = false): T {
  const next: Record<string, unknown> = { ...form };
  for (const key of fichaV2 ? [...KEYS, ...V2_KEYS] as const : KEYS) {
    const incoming = fields[key];
    if (!incoming) continue;
    const current = String(form[key] ?? "").trim();
    // O estado "SP" vem como padrão do formulário em branco: contar como vazio quando igual ao padrão.
    const isDefault = current === "" || current === String(blankForm[key] ?? "").trim();
    if (isDefault) next[key] = incoming;
  }
  if (fichaV2) {
    // Reconcilia data e hora pelo modo que FICOU na ficha (o tipo já escolhido pela equipe não é trocado pelo passe):
    // tour direto não tem horário nem passante; agendamento com data e horário do passe só preenche se estiver vazio e o passe também for agendamento.
    const mode = String(next.visitMode ?? "");
    if (mode === "tour_direto") { next.scheduledAt = ""; if ("isPasserby" in next) next.isPasserby = false; }
    else if (fields.visitMode !== "tour_direto" && fields.visitDate && fields.visitTime && !String(form.scheduledAt ?? "").trim()) next.scheduledAt = `${fields.visitDate}T${fields.visitTime}`;
  }
  return next as T;
}
