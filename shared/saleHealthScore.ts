export type SaleHealthBand = "healthy" | "attention" | "critical";

export type SaleHealthInput = {
  commercialStage: "new" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
  contractStatus?: "draft" | "pending_signature" | "active" | "overdue" | "cancelled" | "closed" | null;
  paidInstallments: number;
  overdueInstallments: number;
  totalInstallments: number;
  documentCount: number;
  requiredDocumentCount: number;
  daysSinceLastInteraction: number | null;
  openFollowUps: number;
  cancellationRequested: boolean;
};

export type SaleHealthFactor = {
  key: string;
  label: string;
  impact: number;
  evidence: string;
};

export type SaleHealthResult = {
  score: number;
  band: SaleHealthBand;
  factors: SaleHealthFactor[];
  nextActions: string[];
};

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function calculateSaleHealth(input: SaleHealthInput): SaleHealthResult {
  let score = 42;
  const factors: SaleHealthFactor[] = [];
  const nextActions: string[] = [];

  const stageImpact: Record<SaleHealthInput["commercialStage"], number> = {
    new: 0,
    qualified: 6,
    proposal: 8,
    negotiation: 5,
    won: 10,
    lost: -25,
  };
  const commercialImpact = stageImpact[input.commercialStage];
  score += commercialImpact;
  factors.push({ key: "commercial_stage", label: "Estágio comercial", impact: commercialImpact, evidence: `Estágio atual: ${input.commercialStage}.` });
  if (input.commercialStage === "lost") nextActions.push("Registrar causa de perda e encerrar ações comerciais abertas.");

  const contractImpact: Record<NonNullable<SaleHealthInput["contractStatus"]>, number> = {
    draft: 0,
    pending_signature: 4,
    active: 12,
    overdue: -15,
    cancelled: -30,
    closed: 2,
  };
  if (input.contractStatus) {
    const impact = contractImpact[input.contractStatus];
    score += impact;
    factors.push({ key: "contract_status", label: "Estado contratual", impact, evidence: `Contrato em ${input.contractStatus}.` });
    if (input.contractStatus === "pending_signature") nextActions.push("Cobrar assinatura e revisar pendências documentais.");
    if (input.contractStatus === "overdue") nextActions.push("Abrir ação de cobrança com dono, promessa e próximo contato.");
    if (input.contractStatus === "cancelled") nextActions.push("Revisar motivo do cancelamento e acionar playbook de retenção ou encerramento.");
  }

  if (input.totalInstallments > 0) {
    const paidRate = input.paidInstallments / input.totalInstallments;
    const paymentImpact = Math.round(Math.min(12, paidRate * 12));
    score += paymentImpact;
    factors.push({ key: "payment_progress", label: "Progresso de recebimento", impact: paymentImpact, evidence: `${input.paidInstallments}/${input.totalInstallments} parcela(s) paga(s).` });
  }
  if (input.overdueInstallments > 0) {
    const impact = -Math.min(28, input.overdueInstallments * 10);
    score += impact;
    factors.push({ key: "overdue_installments", label: "Parcelas em atraso", impact, evidence: `${input.overdueInstallments} parcela(s) em atraso.` });
    nextActions.push("Priorizar contato de cobrança e registrar resultado na timeline.");
  }

  const documentImpact = input.requiredDocumentCount > 0 ? Math.round((Math.min(input.documentCount, input.requiredDocumentCount) / input.requiredDocumentCount) * 10) : 5;
  score += documentImpact;
  factors.push({ key: "documents", label: "Completude documental", impact: documentImpact, evidence: `${input.documentCount}/${input.requiredDocumentCount || "não definida"} documento(s) registrado(s).` });
  if (input.requiredDocumentCount > input.documentCount) nextActions.push("Completar documentos obrigatórios antes de validar o contrato.");

  if (input.daysSinceLastInteraction === null) {
    score -= 8;
    factors.push({ key: "no_interaction", label: "Ausência de interação", impact: -8, evidence: "Nenhuma interação registrada." });
    nextActions.push("Registrar contato de relacionamento e definir próxima ação.");
  } else if (input.daysSinceLastInteraction > 21) {
    score -= 12;
    factors.push({ key: "stale_interaction", label: "Relacionamento parado", impact: -12, evidence: `${input.daysSinceLastInteraction} dia(s) desde a última interação.` });
    nextActions.push("Retomar relacionamento; o cliente está há mais de três semanas sem contato.");
  } else if (input.daysSinceLastInteraction <= 7) {
    score += 6;
    factors.push({ key: "recent_interaction", label: "Interação recente", impact: 6, evidence: `Última interação há ${input.daysSinceLastInteraction} dia(s).` });
  }

  if (input.openFollowUps > 0) {
    const impact = -Math.min(10, input.openFollowUps * 3);
    score += impact;
    factors.push({ key: "open_followups", label: "Pendências abertas", impact, evidence: `${input.openFollowUps} tarefa(s) em aberto.` });
    nextActions.push("Limpar pendências abertas e definir responsável para cada uma.");
  } else {
    score += 4;
    factors.push({ key: "followup_discipline", label: "Disciplina de follow-up", impact: 4, evidence: "Nenhuma tarefa operacional aberta." });
  }

  if (input.cancellationRequested) {
    score -= 25;
    factors.push({ key: "cancellation_requested", label: "Distrato em andamento", impact: -25, evidence: "Existe solicitação de distrato não encerrada." });
    nextActions.push("Tratar a solicitação de distrato em fluxo aprovado e preservar o impacto financeiro.");
  }

  const finalScore = clamp(score);
  const band: SaleHealthBand = finalScore >= 70 ? "healthy" : finalScore >= 45 ? "attention" : "critical";
  return { score: finalScore, band, factors, nextActions: Array.from(new Set(nextActions)).slice(0, 5) };
}
