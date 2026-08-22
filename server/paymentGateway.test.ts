import { describe, expect, it } from "vitest";
import { asaasBillingType, billingExternalReference, getAsaasConfig, isAsaasPaymentConfirmed, isAsaasPaymentOverdue, isAsaasWebhookTokenValid } from "./paymentGateway";

describe("payment gateway", () => {
  it("não habilita Asaas sem chave", () => {
    expect(getAsaasConfig({})).toBeNull();
  });

  it("monta configuração sem expor o segredo e remove a barra da URL", () => {
    expect(getAsaasConfig({ ASAAS_API_KEY: " key ", ASAAS_API_URL: "https://sandbox.asaas.com/", ASAAS_WEBHOOK_TOKEN: " webhook " })).toEqual({ apiKey: "key", baseUrl: "https://sandbox.asaas.com", webhookToken: "webhook" });
  });

  it("mapeia formas e referências determinísticas", () => {
    expect(asaasBillingType("pix")).toBe("PIX");
    expect(asaasBillingType("boleto")).toBe("BOLETO");
    expect(billingExternalReference(42)).toBe("TGR-CRM-INSTALLMENT-42");
  });

  it("reconhece apenas eventos que podem confirmar ou marcar atraso", () => {
    expect(isAsaasPaymentConfirmed("PAYMENT_RECEIVED")).toBe(true);
    expect(isAsaasPaymentConfirmed("PAYMENT_CONFIRMED")).toBe(true);
    expect(isAsaasPaymentConfirmed("PAYMENT_OVERDUE")).toBe(false);
    expect(isAsaasPaymentOverdue("PAYMENT_OVERDUE")).toBe(true);
    expect(isAsaasPaymentOverdue("PAYMENT_RECEIVED")).toBe(false);
  });

  it("exige token de webhook configurado", () => {
    const config = getAsaasConfig({ ASAAS_API_KEY: "key", ASAAS_WEBHOOK_TOKEN: "secret" });
    expect(config).not.toBeNull();
    expect(isAsaasWebhookTokenValid(config!, "secret")).toBe(true);
    expect(isAsaasWebhookTokenValid(config!, "wrong")).toBe(false);
    expect(isAsaasWebhookTokenValid({ ...config!, webhookToken: "" }, "secret")).toBe(false);
  });
});
