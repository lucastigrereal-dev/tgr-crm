export function isValidReservationPeriod(checkIn: Date, checkOut: Date) {
  return checkOut.getTime() > checkIn.getTime();
}

export function shouldCreatePaymentReminder(dueDate: Date, now: Date, leadDays = 7) {
  const threshold = new Date(now.getTime() + leadDays * 86_400_000);
  return dueDate.getTime() <= threshold.getTime();
}

export type CollectionStage = {
  code: "pre_due" | "due_today" | "late_soft" | "late_urgent";
  label: string;
  priority: "normal" | "high" | "urgent";
  actionWithinHours: number;
};

export function getCollectionStage(dueDate: Date, now = new Date()): CollectionStage {
  const daysFromDue = Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000);
  if (daysFromDue < 0) return { code: "pre_due", label: "Pré-vencimento", priority: "normal", actionWithinHours: 48 };
  if (daysFromDue === 0) return { code: "due_today", label: "Vence hoje", priority: "high", actionWithinHours: 24 };
  if (daysFromDue <= 15) return { code: "late_soft", label: "Atraso inicial", priority: "high", actionWithinHours: 24 };
  return { code: "late_urgent", label: "Atraso crítico", priority: "urgent", actionWithinHours: 8 };
}

/** Converte prioridade contratual (1 é máxima, 9 é mínima) em peso para a fila de espera. */
export function entitlementPriorityScore(priorityLevel: number) {
  const normalized = Math.min(9, Math.max(1, Math.round(priorityLevel)));
  return 100 - (normalized - 1) * 10;
}

export function resolveFollowUpAt(value: string | null | undefined, now = new Date()) {
  return value ? new Date(value) : new Date(now.getTime() + 48 * 60 * 60 * 1000);
}

export function buildInstallmentSchedule(totalAmount: number, installmentCount: number, firstDueDate: string) {
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) throw new Error("Total amount must be positive");
  if (!Number.isInteger(installmentCount) || installmentCount < 1) throw new Error("Installment count must be a positive integer");
  const [year, month, day] = firstDueDate.split("-").map(Number);
  if (!year || !month || !day) throw new Error("First due date must be ISO date");
  const totalCents = Math.round(totalAmount * 100);
  const baseCents = Math.floor(totalCents / installmentCount);
  const remainder = totalCents - baseCents * installmentCount;
  return Array.from({ length: installmentCount }, (_, index) => ({
    sequence: index + 1,
    dueDate: new Date(Date.UTC(year, month - 1 + index, day, 12)),
    amount: ((baseCents + (index === 0 ? remainder : 0)) / 100).toFixed(2),
  }));
}
