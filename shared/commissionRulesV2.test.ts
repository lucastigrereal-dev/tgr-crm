import { describe, expect, it } from "vitest";
import { computeCommissionV2, commissionRulesV2Schema, FIVE_COMMISSION_DRAFT_V2 } from "./commissionRulesV2";

// Números 100% sintéticos; valores em centavos.
const amount = (result: ReturnType<typeof computeCommissionV2>, role: string) => result.lines.find((l) => l.role === role)?.amountCents;

describe("regras de comissão V2 (rascunho da Five)", () => {
  it("o rascunho passa no esquema estrito", () => {
    expect(commissionRulesV2Schema.safeParse(FIVE_COMMISSION_DRAFT_V2).success).toBe(true);
  });

  it("captador: R$400 por cota; consultor 10% da entrada; fechador 15% acima de R$3.990", () => {
    const r = computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 2, entryCents: 500_000, saleTotalCents: 28_900_00 });
    expect(amount(r, "captador")).toBe(80_000);
    expect(amount(r, "consultor")).toBe(50_000);
    expect(amount(r, "fechador")).toBe(75_000);
    expect(r.companyRevenueCents).toBe(476_850);
  });

  it("limite exato de R$3.990 cai na faixa de baixo (10%); um centavo acima vai para 15%", () => {
    expect(amount(computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 1, entryCents: 399_000 }), "fechador")).toBe(39_900);
    expect(amount(computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 1, entryCents: 399_001 }), "fechador")).toBe(59_850);
    const fromThreshold = { ...FIVE_COMMISSION_DRAFT_V2, roles: { fechador: { ...(FIVE_COMMISSION_DRAFT_V2.roles.fechador as object), strictlyAbove: false } } };
    expect(amount(computeCommissionV2(fromThreshold, { quotas: 1, entryCents: 399_000 }), "fechador")).toBe(59_850);
  });

  it("taxa da maquininha sai da base: por bps padrão ou pelo valor real da venda", () => {
    const withFee = { ...FIVE_COMMISSION_DRAFT_V2, machineFeeBps: 400 };
    const byRate = computeCommissionV2(withFee, { quotas: 1, entryCents: 500_000 });
    expect(byRate.machineFeeCents).toBe(20_000);
    expect(amount(byRate, "consultor")).toBe(48_000);
    expect(amount(byRate, "fechador")).toBe(72_000);
    const byReal = computeCommissionV2(withFee, { quotas: 1, entryCents: 500_000, machineFeeCents: 10_000 });
    expect(amount(byReal, "consultor")).toBe(49_000);
  });

  it("faixa comparando a entrada efetiva muda de faixa quando a taxa derruba o valor", () => {
    const eff = { ...FIVE_COMMISSION_DRAFT_V2, machineFeeBps: 500, roles: { fechador: { ...(FIVE_COMMISSION_DRAFT_V2.roles.fechador as object), tierBase: "effective" } } };
    expect(amount(computeCommissionV2(eff, { quotas: 1, entryCents: 410_000 }), "fechador")).toBe(Math.floor((389_500 * 1_000 + 5_000) / 10_000));
  });

  it("papel sem regra não gera linha; entrada/cotas inválidas dão erro, nunca zero silencioso", () => {
    expect(computeCommissionV2({ ...FIVE_COMMISSION_DRAFT_V2, roles: {} }, { quotas: 1, entryCents: 100_000 }).lines).toEqual([]);
    expect(() => computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 1.5, entryCents: 1 })).toThrow();
    expect(() => computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 1, entryCents: -1 })).toThrow();
    expect(() => computeCommissionV2({ ...FIVE_COMMISSION_DRAFT_V2, extra: 1 }, { quotas: 1, entryCents: 1 })).toThrow();
  });
});
