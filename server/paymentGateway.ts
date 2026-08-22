export type GatewayBillingType = "pix" | "boleto";
export type AsaasConfig = { apiKey: string; baseUrl: string; webhookToken: string };

export type AsaasCustomerInput = {
  name: string;
  email?: string | null;
  mobilePhone?: string | null;
  cpfCnpj: string;
  externalReference: string;
};

export type AsaasPaymentInput = {
  customer: string;
  billingType: "PIX" | "BOLETO";
  value: number;
  dueDate: string;
  description: string;
  externalReference: string;
};

export type AsaasPayment = {
  id: string;
  status?: string;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  billingType?: string | null;
  value?: number;
  dueDate?: string;
  externalReference?: string | null;
};

export type AsaasPixQrCode = { encodedImage?: string | null; payload?: string | null; expirationDate?: string | null };

export function getAsaasConfig(env: NodeJS.ProcessEnv = process.env): AsaasConfig | null {
  const apiKey = env.ASAAS_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.ASAAS_API_URL?.trim() || "https://api.asaas.com").replace(/\/$/, ""),
    webhookToken: env.ASAAS_WEBHOOK_TOKEN?.trim() || "",
  };
}

export function asaasBillingType(type: GatewayBillingType): "PIX" | "BOLETO" {
  return type === "pix" ? "PIX" : "BOLETO";
}

export function billingExternalReference(installmentId: number) {
  return `TGR-CRM-INSTALLMENT-${installmentId}`;
}

async function asaasRequest<T>(config: AsaasConfig, path: string, init: RequestInit = {}) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      access_token: config.apiKey,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message = typeof body === "object" && body && "errors" in body ? JSON.stringify((body as { errors: unknown }).errors) : `HTTP ${response.status}`;
    throw new Error(`Asaas: ${message}`);
  }
  return body as T;
}

export function createAsaasCustomer(config: AsaasConfig, input: AsaasCustomerInput) {
  return asaasRequest<{ id: string }>(config, "/v3/customers", { method: "POST", body: JSON.stringify(input) });
}

export function createAsaasPayment(config: AsaasConfig, input: AsaasPaymentInput) {
  return asaasRequest<AsaasPayment>(config, "/v3/payments", { method: "POST", body: JSON.stringify(input) });
}

export function findAsaasPaymentsByReference(config: AsaasConfig, externalReference: string) {
  return asaasRequest<{ data: AsaasPayment[] }>(config, `/v3/payments?externalReference=${encodeURIComponent(externalReference)}&limit=10`);
}

export function getAsaasPayment(config: AsaasConfig, paymentId: string) {
  return asaasRequest<AsaasPayment>(config, `/v3/payments/${encodeURIComponent(paymentId)}`);
}

export function getAsaasIdentificationField(config: AsaasConfig, paymentId: string) {
  return asaasRequest<{ identificationField?: string | null }>(config, `/v3/payments/${encodeURIComponent(paymentId)}/identificationField`);
}

export function getAsaasPixQrCode(config: AsaasConfig, paymentId: string) {
  return asaasRequest<AsaasPixQrCode>(config, `/v3/payments/${encodeURIComponent(paymentId)}/pixQrCode`);
}

export function isAsaasPaymentConfirmed(event: string) {
  return event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED";
}

export function isAsaasPaymentOverdue(event: string) {
  return event === "PAYMENT_OVERDUE";
}

export function isAsaasWebhookTokenValid(config: AsaasConfig, token: string | undefined) {
  return Boolean(config.webhookToken) && Boolean(token) && token === config.webhookToken;
}
