import { getDb } from "./db";
import { runNonBuyerDelivery, type DeliveryConfig, type DeliveryOutcome } from "./nonBuyerDelivery";

export type NonBuyerDeliveryJob = { stop: () => void; runOnce: () => Promise<DeliveryOutcome | null> };

/** F2.1: bomba de entrega ao Recovery (a cada 30 s). Só é iniciada com NON_BUYER_DELIVERY_ENABLED=true + RECOVERY_ELIGIBILITY_ENABLED=true + endpoint e chave (index.ts). */
export function startNonBuyerDeliveryJob(config: DeliveryConfig, options: { intervalMs?: number; onError?: (error: unknown) => void; onRun?: (result: DeliveryOutcome) => void } = {}): NonBuyerDeliveryJob {
  let running = false;
  let stopped = false;
  const runOnce = async () => {
    if (running || stopped) return null;
    running = true;
    try {
      const db = await getDb();
      if (!db) return null;
      const result = await runNonBuyerDelivery(db, config);
      options.onRun?.(result);
      return result;
    } catch (error) { options.onError?.(error); return null; } finally { running = false; }
  };
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 30_000);
  timer.unref?.();
  void runOnce();
  return { stop: () => { stopped = true; clearInterval(timer); }, runOnce };
}
