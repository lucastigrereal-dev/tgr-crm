// F1.8 / CRM-a: configuração do prefill do GuestPass. Lida do ambiente a cada chamada (liga/desliga sem rebuild de módulo).
// A chave é a de PONTE `GUESTPASS_CRM_READ_KEY` (a mesma que o GuestPass valida; contrato guestpass.prefill.v1), NUNCA o token de CI do repositório.
// Nenhum valor daqui é logado.

export const GUESTPASS_PASS_REF_PATTERN = /^GP-([0-9A-F]{8}|[0-9A-F]{10})$/;

/** Flag do CRM (nasce false). Distinta da flag do GuestPass (GUESTPASS_CRM_PREFILL_ENABLED), que é do outro lado. */
export function isGuestpassPrefillEnabled(): boolean {
  return process.env.CRM_GUESTPASS_PREFILL_ENABLED === "true";
}

export type GuestpassConfig = { enabled: false } | { enabled: true; configured: false } | { enabled: true; configured: true; baseUrl: string; key: string; timeoutMs: number };

export function resolveGuestpassConfig(): GuestpassConfig {
  if (!isGuestpassPrefillEnabled()) return { enabled: false };
  const key = process.env.GUESTPASS_CRM_READ_KEY?.trim() ?? "";
  const raw = process.env.GUESTPASS_CRM_BASE_URL?.trim() ?? "";
  let baseUrl = "";
  try {
    const url = new URL(raw);
    // A chave de ponte viaja como Bearer: só https, ou http em localhost/127.0.0.1 (teste e desenvolvimento), igual a isAllowedFeedEndpoint (#123) e isAllowedDeliveryEndpoint (#124).
    if (url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) baseUrl = url.origin + url.pathname.replace(/\/+$/, "");
  } catch { /* base inválida = não configurado */ }
  if (!key || !baseUrl) return { enabled: true, configured: false };
  const timeout = Number(process.env.GUESTPASS_CRM_TIMEOUT_MS);
  return { enabled: true, configured: true, baseUrl, key, timeoutMs: Number.isFinite(timeout) && timeout >= 500 && timeout <= 15000 ? timeout : 5000 };
}

/** Normaliza o Nº do passe digitado (aceita minúsculas e espaços); devolve null se fora do padrão. */
export function normalizePassRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toUpperCase();
  return GUESTPASS_PASS_REF_PATTERN.test(candidate) ? candidate : null;
}
