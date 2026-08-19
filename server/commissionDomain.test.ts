import { describe, expect, it } from "vitest";
import { calculateCommission } from "./commissionDomain";

describe("comissões", () => {
  it("calcula comissão com arredondamento monetário", () => {
    expect(calculateCommission(12500, 5)).toBe(625);
    expect(calculateCommission(999.99, 2.5)).toBe(25);
  });

  it("bloqueia base ou taxa fora da regra", () => {
    expect(() => calculateCommission(0, 5)).toThrow("base");
    expect(() => calculateCommission(1000, 101)).toThrow("taxa");
  });
});
