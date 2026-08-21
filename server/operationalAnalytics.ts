export type OperationalExceptionSource = {
  id: number;
  kind: "installment" | "task" | "maintenance" | "waitlist" | "capture" | "opportunity" | "cancellation" | "commission" | "integrity";
  label: string;
  dueAt?: Date | null;
  status: string;
  amount?: string | number;
  responsibleUserName?: string | null;
  responsibleRole?: string | null;
  evidence?: string | null;
};

export type OperationalException = {
  id: string;
  severity: "critical" | "attention";
  module: "finance" | "sales" | "reservations" | "governance";
  title: string;
  description: string;
  responsible: string;
  actionDueAt?: Date | null;
};

export function buildOperationalInsights(input: { exceptions: OperationalExceptionSource[]; eventsLast30Days: { actorUserId: number | null }[]; interactionsLast30Days: number }, now = new Date()) {
  const exceptions: OperationalException[] = input.exceptions.flatMap<OperationalException>(item => {
    if (item.kind === "installment" && (item.status === "overdue" || (item.status === "open" && item.dueAt && item.dueAt < now))) {
      const overdueDays = item.dueAt ? Math.max(0, Math.floor((now.getTime() - item.dueAt.getTime()) / 86_400_000)) : 0;
      return [{ id: `installment-${item.id}`, severity: overdueDays >= 15 ? "critical" : "attention", module: "finance", title: `Parcela em atraso · ${item.label}`, description: `${overdueDays} dia(s) de atraso · R$ ${Number(item.amount ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`, responsible: item.responsibleUserName || item.responsibleRole || "Financeiro", actionDueAt: item.dueAt }];
    }
    if (item.kind === "task" && item.dueAt && item.dueAt < now && ["open", "in_progress"].includes(item.status)) return [{ id: `task-${item.id}`, severity: "attention", module: "sales", title: `Follow-up vencido · ${item.label}`, description: `Prazo estourado em ${item.dueAt.toLocaleDateString("pt-BR")}`, responsible: item.responsibleUserName || item.responsibleRole || "Comercial", actionDueAt: item.dueAt }];
    if (item.kind === "maintenance" && ["planned", "active"].includes(item.status)) return [{ id: `maintenance-${item.id}`, severity: item.status === "active" ? "critical" : "attention", module: "reservations", title: `Manutenção ${item.status === "active" ? "ativa" : "programada"} · ${item.label}`, description: item.dueAt ? `Início em ${item.dueAt.toLocaleDateString("pt-BR")}` : "Sem data de início", responsible: item.responsibleUserName || item.responsibleRole || "Atendimento / operações", actionDueAt: item.dueAt }];
    if (item.kind === "waitlist" && item.status === "offered" && item.dueAt && item.dueAt < now) return [{ id: `waitlist-${item.id}`, severity: "attention", module: "reservations", title: `Oferta de lista de espera expirou · ${item.label}`, description: `Venceu em ${item.dueAt.toLocaleDateString("pt-BR")}`, responsible: item.responsibleUserName || item.responsibleRole || "Atendimento / operações", actionDueAt: item.dueAt }];
    if (item.kind === "capture" && item.status === "captured" && item.dueAt && item.dueAt.getTime() < now.getTime() - 86_400_000) return [{ id: `capture-${item.id}`, severity: "attention", module: "sales", title: `Captação sem desfecho · ${item.label}`, description: `Ficha parada desde ${item.dueAt.toLocaleDateString("pt-BR")}`, responsible: item.responsibleUserName || item.responsibleRole || "Comercial / recepção", actionDueAt: new Date(item.dueAt.getTime() + 86_400_000) }];
    if (item.kind === "opportunity" && ["missing_followup", "overdue_followup"].includes(item.status)) return [{ id: `opportunity-${item.id}`, severity: item.status === "overdue_followup" ? "critical" : "attention", module: "sales", title: `Proposta sem próximo passo · ${item.label}`, description: item.status === "overdue_followup" ? "Follow-up vencido" : "Sem próximo follow-up definido", responsible: item.responsibleUserName || item.responsibleRole || "Vendedor responsável", actionDueAt: item.dueAt }];
    if (item.kind === "cancellation" && item.status === "requested") return [{ id: `cancellation-${item.id}`, severity: "attention", module: "governance", title: `Distrato aguardando decisão · ${item.label}`, description: "Aprovação humana pendente antes de qualquer efeito financeiro", responsible: item.responsibleUserName || item.responsibleRole || "Administração / financeiro", actionDueAt: item.dueAt }];
    if (item.kind === "commission" && item.status !== "paid" && item.status !== "cancelled" && item.dueAt && item.dueAt < now) return [{ id: `commission-${item.id}`, severity: "attention", module: "finance", title: `Comissão sem conciliação · ${item.label}`, description: `Pagamento previsto em ${item.dueAt.toLocaleDateString("pt-BR")}`, responsible: item.responsibleUserName || item.responsibleRole || "Financeiro / comissões", actionDueAt: item.dueAt }];
    if (item.kind === "integrity") return [{ id: `integrity-${item.id}`, severity: item.status === "critical" ? "critical" : "attention", module: item.responsibleRole === "finance" ? "finance" : "governance", title: `Integridade comercial · ${item.label}`, description: item.evidence || "Evidência registrada para revisão humana.", responsible: item.responsibleUserName || item.responsibleRole || "Governança comercial", actionDueAt: item.dueAt }];
    return [];
  }).sort((a, b) => (a.severity === "critical" ? -1 : 1) - (b.severity === "critical" ? -1 : 1));
  return { exceptions, adoption: { eventsLast30Days: input.eventsLast30Days.length, activeOperators: new Set(input.eventsLast30Days.map(event => event.actorUserId).filter(Boolean)).size, interactionsLast30Days: input.interactionsLast30Days } };
}
