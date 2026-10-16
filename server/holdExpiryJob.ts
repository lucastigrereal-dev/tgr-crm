import { getDb } from "./db";
import { sweepExpiredHolds, type HoldSweepOutcome } from "./holdSweep";

export type HoldExpiryJob = { stop: () => void; runOnce: () => Promise<HoldSweepOutcome | null> };

/**
 * Job do vencimento de holds de cota (CRM-PK-11): roda na subida e a cada 5 minutos, devolvendo ao estoque a cota cujo hold
 * venceu sem esperar a próxima reserva nem o botão do admin. Idempotente; uma rodada em andamento não é sobreposta.
 */
export function startHoldExpiryJob(options: { intervalMs?: number; onError?: (error: unknown) => void; onRun?: (result: HoldSweepOutcome) => void } = {}): HoldExpiryJob {
  let running = false;
  let stopped = false;
  const runOnce = async () => {
    if (running || stopped) return null;
    running = true;
    try {
      const db = await getDb();
      if (!db) return null;
      const result = await sweepExpiredHolds(db, { actorUserId: null });
      options.onRun?.(result);
      return result;
    } catch (error) { options.onError?.(error); return null; } finally { running = false; }
  };
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 5 * 60 * 1000);
  timer.unref?.();
  void runOnce();
  return { stop: () => { stopped = true; clearInterval(timer); }, runOnce };
}
