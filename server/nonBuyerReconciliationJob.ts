import { getDb } from "./db";
import { reconcileAllNonBuyerEligibility, type ReconciliationOutcome } from "./nonBuyerEligibilityService";

export type NonBuyerReconciliationJob = { stop: () => void; runOnce: () => Promise<ReconciliationOutcome | null> };

/**
 * Job da reconciliação de elegibilidade de não-comprador (C2/C3 fatia 3). Só é iniciado com RECOVERY_ELIGIBILITY_ENABLED=true (index.ts) e com a migration 0080 aplicada.
 * Roda na subida e a cada 10 minutos; idempotente; uma rodada em andamento não é sobreposta.
 */
export function startNonBuyerReconciliationJob(options: { intervalMs?: number; batchSize?: number; onError?: (error: unknown) => void; onRun?: (result: ReconciliationOutcome) => void } = {}): NonBuyerReconciliationJob {
  let running = false;
  let stopped = false;
  const runOnce = async () => {
    if (running || stopped) return null;
    running = true;
    try {
      const db = await getDb();
      if (!db) return null;
      const result = await reconcileAllNonBuyerEligibility(db, { batchSize: options.batchSize });
      options.onRun?.(result);
      return result;
    } catch (error) { options.onError?.(error); return null; } finally { running = false; }
  };
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 10 * 60 * 1000);
  timer.unref?.();
  void runOnce();
  return { stop: () => { stopped = true; clearInterval(timer); }, runOnce };
}
