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

  it("R$3.990 exato já é 15%; um centavo abaixo é 10% (sobre o líquido)", () => {
    expect(amount(computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 1, entryCents: 399_000 }), "fechador")).toBe(59_850);
    expect(amount(computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 1, entryCents: 398_999 }), "fechador")).toBe(39_900);
    const strict = { ...FIVE_COMMISSION_DRAFT_V2, roles: { fechador: { ...(FIVE_COMMISSION_DRAFT_V2.roles.fechador as object), strictlyAbove: true } } };
    expect(amount(computeCommissionV2(strict, { quotas: 1, entryCents: 399_000 }), "fechador")).toBe(39_900);
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

  it("a faixa olha o líquido: entrada de R$4.100 com maquininha de 5% cai para 10%", () => {
    const fee = { ...FIVE_COMMISSION_DRAFT_V2, machineFeeBps: 500 };
    expect(amount(computeCommissionV2(fee, { quotas: 1, entryCents: 410_000 }), "fechador")).toBe(38_950);
    const gross = { ...fee, roles: { fechador: { ...(FIVE_COMMISSION_DRAFT_V2.roles.fechador as object), tierBase: "gross" } } };
    expect(amount(computeCommissionV2(gross, { quotas: 1, entryCents: 410_000 }), "fechador")).toBe(58_425);
  });

  it("papel sem regra não gera linha; entrada/cotas inválidas dão erro, nunca zero silencioso", () => {
    expect(computeCommissionV2({ ...FIVE_COMMISSION_DRAFT_V2, roles: {} }, { quotas: 1, entryCents: 100_000 }).lines).toEqual([]);
    expect(() => computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 1.5, entryCents: 1 })).toThrow();
    expect(() => computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 1, entryCents: -1 })).toThrow();
    expect(() => computeCommissionV2({ ...FIVE_COMMISSION_DRAFT_V2, extra: 1 }, { quotas: 1, entryCents: 1 })).toThrow();
  });

  it("saleTotalCents inválido (negativo, fracionário, NaN, inseguro) vira erro", () => {
    for (const saleTotalCents of [-1, 10.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => computeCommissionV2(FIVE_COMMISSION_DRAFT_V2, { quotas: 1, entryCents: 399_000, saleTotalCents })).toThrow(/saleTotalCents/);
    }
  });
});

describe("M-A08-02: valores do captador vêm da política, nunca de literal no código", () => {
  it("trocar o valor na política muda o valor pago", () => {
    const rules = (amountCents: number) => ({ schema: "tgr.commission-rules.v2", machineFeeBps: 0, roles: { captador: { kind: "fixed_per_quota", amountCents } } });
    const sale = { quotas: 3, entryCents: 100_000 };
    const line = (amountCents: number) => computeCommissionV2(rules(amountCents), sale).lines.find(l => l.role === "captador")?.amountCents;
    expect(line(40_000)).toBe(120_000);
    expect(line(50_000)).toBe(150_000);
  });
});
