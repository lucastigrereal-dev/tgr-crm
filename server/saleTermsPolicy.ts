import { z } from "zod";

export const saleTermsPolicySchema = z.object({
  usageModel: z.enum(["fixed_week", "flexible_week", "points"]),
  balanceInstallmentCount: z.coerce.number().int().min(1).max(360),
  balanceCadenceMonths: z.coerce.number().int().min(1).max(12).default(1),
  description: z.string().trim().max(500).optional(),
});

export type SaleTermsPolicy = z.infer<typeof saleTermsPolicySchema>;

export function parseSaleTermsPolicy(value: unknown): SaleTermsPolicy {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return saleTermsPolicySchema.parse(parsed);
}

export function splitCents(totalCents: number, count: number) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new TypeError("totalCents must be a non-negative safe integer");
  if (!Number.isSafeInteger(count) || count < 1 || count > 360) throw new TypeError("count must be between 1 and 360");
  const base = Math.floor(totalCents / count);
  const remainder = totalCents % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function parseCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError("calendar date must be YYYY-MM-DD");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new TypeError("invalid calendar date");
  return { year, month, day };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
}

export function addMonthsClamped(value: string, months: number) {
  const parsed = parseCalendarDate(value);
  const zeroBasedTarget = parsed.month - 1 + months;
  const year = parsed.year + Math.floor(zeroBasedTarget / 12);
  const monthIndex = ((zeroBasedTarget % 12) + 12) % 12;
  const month = monthIndex + 1;
  const day = Math.min(parsed.day, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addDays(value: string, days: number) {
  const parsed = parseCalendarDate(value);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days, 12));
  return date.toISOString().slice(0, 10);
}

export function localDateInTimezone(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const map = new Map(parts.map(part => [part.type, part.value]));
  const year = map.get("year"), month = map.get("month"), day = map.get("day");
  if (!year || !month || !day) throw new TypeError("timezone date unavailable");
  return `${year}-${month}-${day}`;
}

export function buildBalanceSchedule(input: {
  balanceCents: number;
  count: number;
  firstDueDate: string;
  cadenceMonths: number;
  sequenceOffset: number;
}) {
  const amounts = splitCents(input.balanceCents, input.count);
  return amounts.map((amountCents, index) => ({
    sequence: input.sequenceOffset + index + 1,
    amountCents,
    dueDate: addMonthsClamped(input.firstDueDate, index * input.cadenceMonths),
  }));
}
