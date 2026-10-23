/**
 * F1.6: ficha sem data de visita ficava ambígua (bug de 16/10: "casal fora da fila"). A fila e os indicadores já tratam a ficha sem data como passante (#117: passante não conta como
 * agendado); a lacuna é a entrada. Com CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY ligada, a recepção precisa informar a data da visita OU marcar "passante" de forma explícita.
 * DESLIGADA por padrão (a ficha sem data segue aceita e vira passante só na leitura). Lida a cada chamada.
 */
export const isCaptureVisitRuleEnabled = () => process.env.CAPTURE_REQUIRE_VISIT_DATE_OR_PASSERBY === "true";

export const VISIT_RULE_MESSAGE = "Informe a data da visita ou marque \"É passante\": ficha sem data e sem passante fica fora da fila e dos indicadores.";

/** Texto do erro quando a ficha não tem data de visita nem passante explícito; nulo quando está de acordo. */
export function visitRuleViolation(input: { scheduledAt?: string | Date | null; isPasserby?: boolean | null }): string | null {
  const hasDate = input.scheduledAt instanceof Date ? !Number.isNaN(input.scheduledAt.getTime()) : Boolean(input.scheduledAt && String(input.scheduledAt).trim());
  return hasDate || input.isPasserby === true ? null : VISIT_RULE_MESSAGE;
}
