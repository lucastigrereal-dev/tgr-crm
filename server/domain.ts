export function isValidReservationPeriod(checkIn: Date, checkOut: Date) {
  return checkOut.getTime() > checkIn.getTime();
}

export function shouldCreatePaymentReminder(dueDate: Date, now: Date, leadDays = 7) {
  const threshold = new Date(now.getTime() + leadDays * 86_400_000);
  return dueDate.getTime() <= threshold.getTime();
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
