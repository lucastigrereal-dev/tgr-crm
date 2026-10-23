import { getDb } from "./db";
import { runErasureSync, type ErasureFeedConfig, type ErasureSyncOutcome } from "./privacyErasureFeed";

export type PrivacyErasureJob = { stop: () => void; runOnce: () => Promise<ErasureSyncOutcome | null> };

/** F2.10: puxa o feed de exclusão do GuestPass a cada 15 min. Só é iniciado com PRIVACY_ERASURE_PROPAGATION_ENABLED=true e configuração completa (index.ts). Idempotente. */
export function startPrivacyErasureJob(config: ErasureFeedConfig, options: { intervalMs?: number; onError?: (error: unknown) => void; onRun?: (result: ErasureSyncOutcome) => void } = {}): PrivacyErasureJob {
  let running = false;
  let stopped = false;
  const runOnce = async () => {
    if (running || stopped) return null;
    running = true;
    try {
      const db = await getDb();
      if (!db) return null;
      const result = await runErasureSync(db, config);
      options.onRun?.(result);
      return result;
    } catch (error) { options.onError?.(error); return null; } finally { running = false; }
  };
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 15 * 60 * 1000);
  timer.unref?.();
  void runOnce();
  return { stop: () => { stopped = true; clearInterval(timer); }, runOnce };
}
