import {
  commissionAssignments,
  commissionDates,
  commissionStatus,
  releasedCommission,
  type PaymentMethod,
} from "./commissionLifecycle";

export type CommissionRates = Partial<Record<"liner" | "closer" | "ftb", number>>;
export type CommissionRoleV2Mapped = "promoter" | "liner" | "closer";

// ADR-010: papel sem taxa (ou 0%) vale 0 e não gera lançamento.
export const commissionRoleRate = (rates: CommissionRates | undefined, role: "liner" | "closer" | "ftb") => {
  const rate = rates?.[role];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : 0;
};

export function buildInstallmentCommissions(input: {
  installmentId: number;
  installmentAmount: number;
  entryTotal: number;
  contractTotal: number;
  paymentMethod: PaymentMethod;
  compensatedAt: Date;
  linerId: number | null;
  closerId: number | null;
  rates?: CommissionRates;
  /** Issue #38 (1): acumulado já lançado (não cancelado) por papel neste contrato; limita o liberado ao total devido. */
  alreadyReleased?: Partial<Record<"liner" | "closer" | "ftb" | "promoter", number>>;
  calendar?: {
    cancellationDeadlineDay?: number;
    expectedPaymentDay?: number;
  };
}) {
  const assignments = commissionAssignments({
    linerId: input.linerId,
    closerId: input.closerId,
  });

  // ADR-010: percentual é parâmetro por papel com padrão 0%. Papel sem taxa (ou 0%) NÃO gera lançamento — nada é inventado.
  // Não há taxa histórica de fallback.
  const rateOf = (role: "liner" | "closer" | "ftb") => commissionRoleRate(input.rates, role);
  const payable = assignments.filter((assignee) => rateOf(assignee.role) > 0);
  if (!payable.length) return [];

  const base = Math.max(0, input.contractTotal - input.entryTotal);
  const dates = commissionDates(
    input.paymentMethod,
    input.compensatedAt,
    input.calendar,
  );

  const rows = payable.map((assignee) => {
    const rate = rateOf(assignee.role);
    const total = Math.round(base * rate * 100) / 100;
    const amount = releasedCommission(
      input.installmentAmount,
      input.entryTotal,
      total,
      input.alreadyReleased?.[assignee.role] ?? 0,
    );
    return {
      sellerId: assignee.userId,
      commissionRole: assignee.role,
      sourceInstallmentId: input.installmentId,
      baseAmount: base,
      rate: total && base > 0 ? (total / base) * 100 : rate * 100,
      amount,
      paymentMethod: input.paymentMethod,
      compensatedAt: input.compensatedAt,
      ...dates,
      lifecycleStatus: commissionStatus({
        compensatedAt: input.compensatedAt,
        receivedAt: null,
        cancelledAt: null,
        ...dates,
        now: input.compensatedAt,
      }),
    };
  });
  // Issue #38 (1): papel que já recebeu o total devido não ganha lançamento extra nas parcelas seguintes.
  return rows.filter((row) => !(row.amount <= 0 && (input.alreadyReleased?.[row.commissionRole] ?? 0) > 0));
}

// PRD Apêndice B #17 (PILOTO V1) + ADR-007 (V6): comissão só pode virar devida com contrato ATIVO, política completa do
// empreendimento e VENDA VALIDADA (sale_validations.validatedAt). `saleValidated` é obrigatório de propósito: sem ele a
// comissão ficaria liberada por engano. Sem qualquer um, fica bloqueada (auditado como commission_blocked).
/**
 * CRM-F2: a parcela pertence à ENTRADA quando o acumulado do cronograma (em ordem de sequência) até ela cabe no valor de entrada da proposta.
 * Sales guarda entrada e saldo juntos: baixar o saldo não pode disparar a comissão do V2.
 */
export type EntryScheduleRow = { id: number; sequence: number; amount: string | number; status?: string; dueDate?: string | Date | null; paidAmount?: string | number | null };
export type AppliedRenegotiation = { originalInstallmentId: number; proposedAmount: string | number; proposedDueDate: string | Date | null };
const cents = (value: string | number) => Math.round(Number(value) * 100);
const dayOf = (value: string | Date | null | undefined) => value == null ? "" : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

/**
 * CRM-F2 (correção): conjunto das parcelas que compõem a ENTRADA. Canceladas ficam fora do acumulado. Uma parcela renegociada ocupa a posição da
 * original (valor original) e a parcela criada pelo acordo (installment_renegotiations.originalInstallmentId; sem FK, casada por contrato, valor, vencimento
 * e sequência posterior) NÃO soma de novo: ela herda a condição de entrada da original. Renegociada sem parcela de acordo localizável fica fora.
 */
export function entryInstallmentIds(schedule: EntryScheduleRow[], entryTotal: number, renegotiations: AppliedRenegotiation[] = []): Set<number> {
  return resolveEntry(schedule, entryTotal, renegotiations).ids;
}

function resolveEntry(schedule: EntryScheduleRow[], entryTotal: number, renegotiations: AppliedRenegotiation[]): { ids: Set<number>; ancestors: Map<number, number[]> } {
  const rows = [...schedule].sort((a, b) => a.sequence - b.sequence);
  const byId = new Map(rows.map(row => [row.id, row]));
  const successorOf = new Map<number, number>();
  const claimed = new Set<number>();
  for (const reneg of renegotiations) {
    const original = byId.get(reneg.originalInstallmentId);
    if (!original || successorOf.has(original.id)) continue;
    const successor = rows.find(row => row.sequence > original.sequence && !claimed.has(row.id) && row.status !== "cancelled" && cents(row.amount) === cents(reneg.proposedAmount) && dayOf(row.dueDate) === dayOf(reneg.proposedDueDate));
    if (successor) { successorOf.set(original.id, successor.id); claimed.add(successor.id); }
  }
  const limit = cents(entryTotal);
  const inEntry: number[] = [];
  let cumulative = 0;
  for (const row of rows) {
    if (row.status === "cancelled" || claimed.has(row.id)) continue;
    if (row.status === "renegotiated" && !successorOf.has(row.id)) continue;
    cumulative += cents(row.amount);
    if (cumulative <= limit) inEntry.push(row.id);
  }
  const result = new Set<number>();
  const ancestors = new Map<number, number[]>();
  for (const id of inEntry) {
    let current = id;
    const seen = new Set<number>();
    while (byId.get(current)?.status === "renegotiated" && successorOf.has(current) && !seen.has(current)) { seen.add(current); current = successorOf.get(current)!; }
    const final = byId.get(current);
    if (final && final.status !== "renegotiated" && final.status !== "cancelled") { result.add(current); ancestors.set(current, Array.from(seen)); }
  }
  return { ids: result, ancestors };
}

export function isEntryInstallment(schedule: EntryScheduleRow[], installmentId: number, entryTotal: number, renegotiations: AppliedRenegotiation[] = []) {
  return entryInstallmentIds(schedule, entryTotal, renegotiations).has(installmentId);
}

/** Acumulado PAGO da entrada (parcelas da entrada com status paid), em reais. */
export function paidEntryAmount(schedule: EntryScheduleRow[], entryTotal: number, renegotiations: AppliedRenegotiation[] = []) {
  const { ids, ancestors } = resolveEntry(schedule, entryTotal, renegotiations);
  const byId = new Map(schedule.map(row => [row.id, row]));
  let total = schedule.filter(row => ids.has(row.id) && row.status === "paid").reduce((sum, row) => sum + cents(row.paidAmount ?? row.amount), 0);
  // Pagamento parcial retido nas parcelas renegociadas (ancestrais) continua sendo dinheiro recebido da entrada.
  ancestors.forEach(chain => { for (const ancestorId of chain) total += cents(byId.get(ancestorId)?.paidAmount ?? 0); });
  return total / 100;
}

export function canCommissionBecomeDue(contractStatus: string | null | undefined, completePolicy: unknown, saleValidated: boolean): boolean {
  return Boolean(completePolicy) && contractStatus === "active" && saleValidated === true;
}

/**
 * CRM-A13: comissão por parcela pelas regras V2. O TOTAL de cada papel vem do motor puro (centavos -> reais) e a parcela libera a fração
 * dele na mesma proporção da entrada recebida (mesma `releasedCommission` do V1: nunca passa do total devido). Só é chamada com a política
 * V2 LIBERADA; travada, ninguém chama. Valor fixo por cota pode superar a entrada, então a taxa gravada (coluna decimal(5,2)) é limitada.
 */
export function buildInstallmentCommissionsV2(input: {
  installmentId: number;
  installmentAmount: number;
  entryTotal: number;
  paymentMethod: PaymentMethod;
  compensatedAt: Date;
  lines: Array<{ role: CommissionRoleV2Mapped; userId: number; totalReais: number }>;
  alreadyReleased?: Partial<Record<"liner" | "closer" | "ftb" | "promoter", number>>;
  calendar?: { cancellationDeadlineDay?: number; expectedPaymentDay?: number };
  /** CRM-F2: `full_upfront` libera o total do papel (menos o já liberado) de uma vez; `per_installment` (padrão desta função pura) é proporcional à parcela. */
  payoutMode?: "full_upfront" | "per_installment";
}) {
  const dates = commissionDates(input.paymentMethod, input.compensatedAt, input.calendar);
  const rows = input.lines.filter(line => line.totalReais > 0).map(line => {
    const total = Math.round(line.totalReais * 100) / 100;
    const amount = input.payoutMode === "full_upfront" && input.installmentAmount > 0 && input.entryTotal > 0
      ? Math.max(0, Math.round((total - (input.alreadyReleased?.[line.role] ?? 0)) * 100) / 100)
      : releasedCommission(input.installmentAmount, input.entryTotal, total, input.alreadyReleased?.[line.role] ?? 0);
    return {
      sellerId: line.userId,
      commissionRole: line.role,
      sourceInstallmentId: input.installmentId,
      baseAmount: input.entryTotal,
      rate: input.entryTotal > 0 ? Math.min(999.99, Math.round((total / input.entryTotal) * 10_000) / 100) : 0,
      amount,
      paymentMethod: input.paymentMethod,
      compensatedAt: input.compensatedAt,
      ...dates,
      lifecycleStatus: commissionStatus({ compensatedAt: input.compensatedAt, receivedAt: null, cancelledAt: null, ...dates, now: input.compensatedAt }),
    };
  });
  return rows.filter(row => !(row.amount <= 0 && (input.alreadyReleased?.[row.commissionRole] ?? 0) > 0));
}
