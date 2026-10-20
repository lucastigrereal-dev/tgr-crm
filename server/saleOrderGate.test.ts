import { afterEach, describe, expect, it } from "vitest";
import { conferralsBeforeGeneration, isSaleOrderGateEnabled, saleOrderGateExempt } from "./saleOrderGate";

describe("ordem da formalização (B1)", () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });
  it("desligado por padrão; só 'true' liga", () => {
    delete process.env.SALE_ORDER_GATE_ENABLED;
    expect(isSaleOrderGateEnabled()).toBe(false);
    process.env.SALE_ORDER_GATE_ENABLED = "1";
    expect(isSaleOrderGateEnabled()).toBe(false);
    process.env.SALE_ORDER_GATE_ENABLED = "true";
    expect(isSaleOrderGateEnabled()).toBe(true);
  });
  it("grandfathering: contrato criado antes de SALE_ORDER_GATE_SINCE é isento; sem a variável ninguém é isento", () => {
    expect(saleOrderGateExempt(new Date("2026-10-01T00:00:00Z"), undefined)).toBe(false);
    expect(saleOrderGateExempt(new Date("2026-10-01T00:00:00Z"), "2026-10-20T00:00:00Z")).toBe(true);
    expect(saleOrderGateExempt(new Date("2026-10-21T00:00:00Z"), "2026-10-20T00:00:00Z")).toBe(false);
    expect(saleOrderGateExempt(new Date("2026-10-01T00:00:00Z"), "lixo")).toBe(false);
  });
  it("o contrato precisa ser gerado depois das duas conferências (tolerância de 1 s do MySQL)", () => {
    const t = (s: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, s));
    expect(conferralsBeforeGeneration({ contractGeneratedAt: t(30), receiptConferredAt: t(10), documentsConferredAt: t(20) })).toBe(true);
    expect(conferralsBeforeGeneration({ contractGeneratedAt: t(20), receiptConferredAt: t(10), documentsConferredAt: t(20) })).toBe(true);
    expect(conferralsBeforeGeneration({ contractGeneratedAt: t(19), receiptConferredAt: t(10), documentsConferredAt: t(20) })).toBe(true); // 1 s de tolerância
    expect(conferralsBeforeGeneration({ contractGeneratedAt: t(15), receiptConferredAt: t(10), documentsConferredAt: t(20) })).toBe(false);
  });
});
