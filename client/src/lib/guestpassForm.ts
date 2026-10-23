// F1.8 / CRM-b: aplica os campos do prefill do GuestPass na ficha SEM apagar o que a equipe já digitou (só preenche campo vazio).
export type GuestpassFields = { fullName: string; partnerName: string; phone: string; city: string; state: string; lodgingLocation: string; captureLocation: string; visitDate: string | null };

const KEYS = ["fullName", "partnerName", "phone", "city", "state", "lodgingLocation", "captureLocation"] as const;

export function applyGuestpassFields<T extends Record<string, unknown>>(form: T, fields: GuestpassFields, blankForm: T): T {
  const next: Record<string, unknown> = { ...form };
  for (const key of KEYS) {
    const incoming = fields[key];
    if (!incoming) continue;
    const current = String(form[key] ?? "").trim();
    // O estado "SP" vem como padrão do formulário em branco: contar como vazio quando igual ao padrão.
    const isDefault = current === "" || current === String(blankForm[key] ?? "").trim();
    if (isDefault) next[key] = incoming;
  }
  return next as T;
}
