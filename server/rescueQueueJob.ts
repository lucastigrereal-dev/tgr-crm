import { getDb } from "./db";
import { runRescueSweep, type SweepOutcome } from "./rescueShadow";

export type RescueQueueJob = { stop: () => void; runOnce: () => Promise<SweepOutcome | null> };

/**
 * F3.1 (MODO SOMBRA): varredura do resgate. Só é iniciada com RESCUE_QUEUE_ENABLED=true (index.ts) e com a migration PROPOSED_0086 aplicada. Roda na subida e a cada 30 minutos;
 * idempotente; rodada em andamento não é sobreposta. Só registra casos e eventos internos: nunca cancela contrato.
 */
export function startRescueQueueJob(options: { intervalMs?: number; onError?: (error: unknown) => void; onRun?: (result: SweepOutcome) => void } = {}): RescueQueueJob {
  let running = false;
  let stopped = false;
  const runOnce = async () => {
    if (running || stopped) return null;
    running = true;
    try {
      const db = await getDb();
      if (!db) return null;
      const result = await runRescueSweep(db);
      options.onRun?.(result);
      return result;
    } catch (error) { options.onError?.(error); return null; } finally { running = false; }
  };
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 30 * 60 * 1000);
  timer.unref?.();
  void runOnce();
  return { stop: () => { stopped = true; clearInterval(timer); }, runOnce };
}
