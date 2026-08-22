export type CommercialRole = "promoter" | "qualifier" | "liner" | "closer" | "ftb" | "room_manager" | "finance";
export type ProfessionalRhythmFact = { userId: number; role: CommercialRole; eventAt: Date; label: string; entityId: number };
export type ProfessionalRhythmAlert = { id: string; userId: number; role: CommercialRole; severity: "attention" | "critical"; daysWithoutEvent: number; lastEventAt: Date | null; evidence: string; recommendedAction: string };

const roleLabels: Record<CommercialRole, string> = { promoter: "Captador", qualifier: "Qualificador", liner: "Liner", closer: "Fechador", ftb: "FTB", room_manager: "Gerente de sala", finance: "Financeiro" };
const actions: Record<CommercialRole, string> = { promoter: "Revisar escala, canal e qualidade das captações.", qualifier: "Conferir fila, checklist e distribuição de atendimento.", liner: "Revisar tours, objeções e avanço para proposta.", closer: "Revisar propostas em aberto, passagem de bastão e apoio de mesa.", ftb: "Revisar tours, propostas e fechamento na mesma mesa.", room_manager: "Revisar carga, equidade de mesa e plano do turno.", finance: "Revisar carteira, atrasos e tentativas de cobrança." };

export function buildProfessionalRhythmAlerts(input: { roster: Array<{ userId: number; role: CommercialRole }>; facts: ProfessionalRhythmFact[]; now?: Date; attentionAfterDays?: number; criticalAfterDays?: number }): ProfessionalRhythmAlert[] {
  const now = input.now ?? new Date();
  const attentionAfterDays = input.attentionAfterDays ?? 2;
  const criticalAfterDays = input.criticalAfterDays ?? 3;
  return input.roster.flatMap(member => {
    const latest = input.facts.filter(fact => fact.userId === member.userId && fact.role === member.role).sort((left, right) => right.eventAt.getTime() - left.eventAt.getTime())[0];
    const daysWithoutEvent = latest ? Math.max(0, Math.floor((now.getTime() - latest.eventAt.getTime()) / 86_400_000)) : criticalAfterDays;
    if (daysWithoutEvent < attentionAfterDays) return [];
    const severity = daysWithoutEvent >= criticalAfterDays ? "critical" : "attention";
    const evidence = latest ? `Último evento: ${latest.label} em ${latest.eventAt.toLocaleDateString("pt-BR")}.` : `Nenhum evento operacional do papel ${roleLabels[member.role]} no período monitorado.`;
    return [{ id: `rhythm-${member.role}-${member.userId}`, userId: member.userId, role: member.role, severity, daysWithoutEvent, lastEventAt: latest?.eventAt ?? null, evidence, recommendedAction: actions[member.role] }];
  });
}
