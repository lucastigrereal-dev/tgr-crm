export function calculateCampaignProgress(targetAmount: number, salesAmount: number) {
  const target = Math.max(0, targetAmount);
  const sales = Math.max(0, salesAmount);
  const percentage = target ? Math.round((sales / target) * 10_000) / 100 : 0;
  return { targetAmount: target, salesAmount: sales, percentage, progress: Math.min(100, percentage), gapAmount: Math.max(0, target - sales), exceededAmount: Math.max(0, sales - target) };
}
