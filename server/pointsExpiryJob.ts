import { settleAllExpirations } from "./routers/pointsLedger";

export type PointsExpiryJob = { stop: () => void; runOnce: () => Promise<{ checked: number; settled: number } | null> };

/**
 * Job do vencimento dos pontos anuais (CRM-22): roda na subida e a cada 6 horas, baixando o que venceu sem esperar o
 * próximo lançamento do direito. Idempotente por chave de vencimento; duas instâncias juntas não duplicam baixa. Uma
 * rodada em andamento não é sobreposta.
 */
export function startPointsExpiryJob(options: { intervalMs?: number; onError?: (error: unknown) => void; onRun?: (result: { checked: number; settled: number }) => void } = {}): PointsExpiryJob {
  let running = false;
  let stopped = false;
  const runOnce = async () => {
    if (running || stopped) return null;
    running = true;
    try {
      const result = await settleAllExpirations(options.onError);
      options.onRun?.(result);
      return result;
    } catch (error) { options.onError?.(error); return null; } finally { running = false; }
  };
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 6 * 60 * 60 * 1000);
  timer.unref?.();
  void runOnce();
  return { stop: () => { stopped = true; clearInterval(timer); }, runOnce };
}
