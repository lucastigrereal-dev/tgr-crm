export type RelationshipRadarInput = {
  hasEmail: boolean;
  hasPhone: boolean;
  interactionDates: Date[];
  documentCount: number;
  contractStatuses: string[];
  reservationDates: Date[];
  installmentStatuses: string[];
};

export type RelationshipRadar = {
  score: number;
  label: "saudável" | "atenção" | "crítico";
  signals: string[];
  onboarding: { label: string; complete: boolean }[];
};

export function buildRelationshipRadar(input: RelationshipRadarInput, now = new Date()): RelationshipRadar {
  const activeContract = input.contractStatuses.includes("active");
  const recentInteraction = input.interactionDates.some(date => now.getTime() - date.getTime() <= 30 * 86400000);
  const upcomingReservation = input.reservationDates.some(date => date.getTime() >= now.getTime());
  const noOverdueInstallment = !input.installmentStatuses.includes("overdue");
  const contactComplete = input.hasEmail && input.hasPhone;
  const documented = input.documentCount > 0;
  const score = (contactComplete ? 20 : 0) + (recentInteraction ? 20 : 0) + (activeContract ? 20 : 0) + (documented ? 10 : 0) + (upcomingReservation ? 15 : 0) + (noOverdueInstallment ? 15 : 0);
  const signals: string[] = [];
  if (!contactComplete) signals.push("Complete telefone e e-mail para não atender no escuro.");
  if (!recentInteraction) signals.push("Sem interação registrada nos últimos 30 dias.");
  if (activeContract && !upcomingReservation) signals.push("Associado ativo sem próxima experiência de uso agendada.");
  if (!noOverdueInstallment) signals.push("Há parcela em atraso exigindo abordagem coordenada com o financeiro.");
  if (!signals.length) signals.push("Relacionamento com cadência, dados e situação financeira sob controle.");
  return { score, label: score >= 75 ? "saudável" : score >= 45 ? "atenção" : "crítico", signals, onboarding: [
    { label: "Canais de contato completos", complete: contactComplete },
    { label: "Primeiro contato registrado", complete: input.interactionDates.length > 0 },
    { label: "Contrato ativo", complete: activeContract },
    { label: "Documento anexado", complete: documented },
    { label: "Primeira experiência de uso agendada", complete: upcomingReservation },
  ] };
}
