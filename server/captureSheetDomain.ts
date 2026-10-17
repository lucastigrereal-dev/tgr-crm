/**
 * Código do casal: o mesmo que o Sales Command já imprime no QR. A ficha abre por ele, só para quem tem login e permissão
 * (o código não é segredo: o acesso é controlado pelo login). Aceita só letras, números, "-" e "_"; nunca CPF ou telefone.
 */
export const normalizeCoupleCode = (value: string) => value.trim();
export const isCoupleCode = (value: string) => /^[A-Za-z0-9_-]{4,64}$/.test(value) && !/^\d{10,}$/.test(value);

/** Tempo de relacionamento em dias, derivado de anos e meses da ficha (aproximação de 365 e 30 dias; vazio quando não informado). */
export function relationshipDays(years?: number | null, months?: number | null) {
  if (years == null && months == null) return null;
  return (years ?? 0) * 365 + (months ?? 0) * 30;
}

/**
 * Ordem de chegada: posição da ficha entre os check-ins do mesmo dia e da mesma sala, pela hora do check-in
 * (empate desempata pelo id). Sem check-in, não há ordem.
 */
export function arrivalOrder(target: { id: number; checkedInAt: Date | null }, sameDayCheckIns: Array<{ id: number; checkedInAt: Date | null }>) {
  if (!target.checkedInAt) return null;
  const before = sameDayCheckIns.filter(row => row.checkedInAt && row.id !== target.id && (row.checkedInAt.getTime() < target.checkedInAt!.getTime() || (row.checkedInAt.getTime() === target.checkedInAt!.getTime() && row.id < target.id)));
  return before.length + 1;
}
