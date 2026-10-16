import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(async () => ({})) }));
const sweep = vi.hoisted(() => vi.fn());
vi.mock("./holdSweep", () => ({ sweepExpiredHolds: sweep }));

import { startHoldExpiryJob } from "./holdExpiryJob";

describe("job de vencimento de holds", () => {
  beforeEach(() => { vi.useFakeTimers(); sweep.mockReset(); sweep.mockResolvedValue({ holds: 0, fractions: [] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("roda na partida e a cada intervalo, sem ator humano", async () => {
    const job = startHoldExpiryJob({ intervalMs: 5 * 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenLastCalledWith(expect.anything(), { actorUserId: null });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(3);
    job.stop();
  });

  it("stop cancela o intervalo", async () => {
    const job = startHoldExpiryJob({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    job.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("erro numa rodada vai para o callback e não derruba o job", async () => {
    const onError = vi.fn();
    sweep.mockRejectedValueOnce(new Error("banco caiu"));
    const job = startHoldExpiryJob({ intervalMs: 1000, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    job.stop();
  });

  it("não sobrepõe uma rodada em andamento", async () => {
    let release: (value: { holds: number; fractions: number[] }) => void = () => {};
    sweep.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const job = startHoldExpiryJob({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweep).toHaveBeenCalledTimes(1);
    release({ holds: 0, fractions: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    job.stop();
  });
});
