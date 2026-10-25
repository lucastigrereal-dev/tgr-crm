/**
 * CRM-D1: indicadores OFICIAIS do CRM (provisórios, editáveis por admin).
 * aproveitamento = vendas validadas / atendimentos; eficiência = cotas vendidas por 100 atendimentos.
 * Numeradores só do CRM (venda validada = sale_validations.validatedAt, contrato não cancelado; nunca stage "won" manual).
 * Denominador (padrão, recomendação 14/10 e 20/10, aceite pendente de ratificação do Lucas): atendimentos INICIADOS (check-in no período), inclusive em andamento; configurável.
 * Coorte pelo dia de início do atendimento no fuso do projeto; o resultado da sala (VENDEU, CAIU EM MESA, NT) nunca é venda validada.
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

/**
 * Coorte pelo início do atendimento (M-A01-03): a venda validada é atribuída ao ÚLTIMO check-in do casal que não é posterior
 * à validação. Um atendimento não conta duas vezes e uma validação tardia muda só o numerador do mês do check-in.
 */
export function attributeSaleToCheckIn(checkIns: Date[], validatedAt: Date): Date | null {
  let best: Date | null = null;
  for (const at of checkIns) if (at <= validatedAt && (!best || at > best)) best = at;
  return best;
}

/** Desfechos de sala dos atendimentos iniciados no período: VENDEU, CAIU EM MESA e NT são coisas separadas; nenhum deles é venda validada. */
export function classifyOutcomes(facts: AttendanceFact[], from: Date, to: Date) {
  const started = facts.filter(fact => fact.checkedInAt && fact.checkedInAt >= from && fact.checkedInAt < to);
  const out = { started: started.length, vendeu: 0, caiuEmMesa: 0, naoTour: 0, encerradoSemVenda: 0, emAndamento: 0 };
  for (const fact of started) {
    if (fact.commercialOutcome === "caiu_em_mesa") out.caiuEmMesa += 1;
    else if (fact.commercialOutcome === "vendeu") out.vendeu += 1;
    else if (fact.ntKind || fact.presentationStatus === "no_tour") out.naoTour += 1;
    else if (fact.presentationStatus === "closed") out.encerradoSemVenda += 1; // só o estado de sala gravado: venda validada do CRM não reclassifica o desfecho da sala
    else out.emAndamento += 1;
  }
  return out;
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
