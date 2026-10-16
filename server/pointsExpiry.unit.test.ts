import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(async () => ({})) }));
const settle = vi.hoisted(() => vi.fn());
vi.mock("./routers/pointsLedger", async importOriginal => ({ ...(await importOriginal<typeof import("./routers/pointsLedger")>()), settleAllExpirations: settle }));

import { POINTS_VALIDITY_YEARS, unsettledExpiredYears } from "./routers/pointsLedger";
import { startPointsExpiryJob } from "./pointsExpiryJob";

let nextId = 1;
const credit = (referenceYear: number) => ({ id: nextId++, entryType: "annual_credit", points: 100, referenceYear, reversesEntryId: null });
const expiration = (referenceYear: number) => ({ id: nextId++, entryType: "expiration", points: -100, referenceYear, reversesEntryId: null });

describe("unsettledExpiredYears", () => {
  const currentYear = 2030;
  it("lista vazia não tem nada vencido", () => expect(unsettledExpiredYears([], currentYear)).toEqual([]));
  it("ano ainda válido não vence", () => expect(unsettledExpiredYears([credit(currentYear), credit(currentYear - POINTS_VALIDITY_YEARS + 1)], currentYear)).toEqual([]));
  it("limite exato: crédito de currentYear - validade já venceu", () => expect(unsettledExpiredYears([credit(currentYear - POINTS_VALIDITY_YEARS)], currentYear)).toEqual([currentYear - POINTS_VALIDITY_YEARS]));
  it("ano vencido sem marcador entra", () => expect(unsettledExpiredYears([credit(2020)], currentYear)).toEqual([2020]));
  it("ano vencido que já tem linha de vencimento não entra", () => expect(unsettledExpiredYears([credit(2020), expiration(2020)], currentYear)).toEqual([]));
  it("anos misturados saem em ordem crescente e sem duplicar", () => {
    const rows = [credit(2026), credit(2022), credit(2022), credit(2020), expiration(2020), credit(currentYear)];
    expect(unsettledExpiredYears(rows, currentYear)).toEqual([2022, 2026]);
  });
});

describe("job de vencimento de pontos", () => {
  beforeEach(() => { vi.useFakeTimers(); settle.mockReset(); settle.mockResolvedValue({ checked: 0, settled: 0 }); });
  afterEach(() => { vi.useRealTimers(); });

  it("roda na partida e de novo a cada 6 horas", async () => {
    const job = startPointsExpiryJob();
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(settle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(settle).toHaveBeenCalledTimes(3);
    job.stop();
  });

  it("stop cancela o intervalo", async () => {
    const job = startPointsExpiryJob({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    job.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("erro numa rodada vai pro callback e não derruba as próximas", async () => {
    const onError = vi.fn();
    settle.mockRejectedValueOnce(new Error("banco fora"));
    const job = startPointsExpiryJob({ intervalMs: 1000, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settle).toHaveBeenCalledTimes(2);
    job.stop();
  });
});
