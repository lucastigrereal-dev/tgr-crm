export function calculateCommission(baseAmount: number, rate: number) {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) throw new Error("A base da comissão precisa ser positiva.");
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error("A taxa de comissão deve estar entre 0 e 100.");
  return Math.round((baseAmount * rate / 100 + Number.EPSILON) * 100) / 100;
}
