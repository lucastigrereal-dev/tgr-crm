/**
 * CRM-D1: indicadores OFICIAIS do CRM (provisórios, editáveis por admin).
 * aproveitamento = vendas validadas / atendimentos; eficiência = cotas vendidas por 100 atendimentos.
 * Numeradores só do CRM (venda validada = sale_validations.validatedAt, contrato não cancelado; nunca stage "won" manual).
 * Denominador (padrão provisório): casal com check-in da recepção no período E desfecho registrado; em andamento fica fora (configurável).
 */
export const OFFICIAL_INDICATORS_DEFINITION_VERSION = "provisorio-1";
export const INCLUDE_IN_PROGRESS_KEY = "official_indicators_include_in_progress";

export type AttendanceFact = {
  checkedInAt: Date | null;
  presentationStatus: "captured" | "scheduled" | "checked_in" | "presented" | "no_tour" | "closed";
  commercialOutcome: "vendeu" | "caiu_em_mesa" | null;
  ntKind: "perfil" | "tempo" | "consultor" | null;
  /** Há venda validada do CRM ligada a este casal (desfecho oficial). */
  hasValidatedSale?: boolean;
};

/** Desfecho registrado: resultado comercial, não tour (NT), ficha encerrada ou venda validada. */
export function hasOutcome(fact: AttendanceFact) {
  return Boolean(fact.commercialOutcome || fact.ntKind || fact.hasValidatedSale || fact.presentationStatus === "closed" || fact.presentationStatus === "no_tour");
}

export function classifyAttendances(facts: AttendanceFact[], from: Date, to: Date, includeInProgress: boolean) {
  const checkedIn = facts.filter(fact => fact.checkedInAt && fact.checkedInAt >= from && fact.checkedInAt < to);
  const concluded = checkedIn.filter(hasOutcome);
  const inProgress = checkedIn.length - concluded.length;
  return { attendances: includeInProgress ? checkedIn.length : concluded.length, inProgressExcluded: includeInProgress ? 0 : inProgress, inProgressTotal: inProgress };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function computeOfficialIndicators(input: { attendances: number; validatedSales: number; soldQuotas: number }) {
  const { attendances, validatedSales, soldQuotas } = input;
  return {
    utilizationPct: attendances ? round2((validatedSales / attendances) * 100) : 0,
    efficiencyPer100: attendances ? round2((soldQuotas / attendances) * 100) : 0,
    validatedSales, soldQuotas, attendances,
  };
}
