import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchWithTimeout } from "./integrationReliability";

export type ClicksignConfig = {
  token: string;
  baseUrl: string;
  webhookSecret: string;
};

export type JsonApiResource<T = Record<string, unknown>> = {
  id: string;
  type: string;
  attributes?: T;
};

export function getClicksignConfig(env: NodeJS.ProcessEnv = process.env): ClicksignConfig | null {
  const token = env.CLICKSIGN_API_TOKEN?.trim();
  const webhookSecret = env.CLICKSIGN_WEBHOOK_SECRET?.trim();
  if (!token || !webhookSecret) return null;
  const explicitUrl = env.CLICKSIGN_API_URL?.trim();
  if (env.NODE_ENV === "production" && !explicitUrl) return null;
  return {
    token,
    webhookSecret,
    baseUrl: (explicitUrl || "https://sandbox.clicksign.com").replace(/\/+$/, ""),
  };
}

async function clicksignRequest<T>(
  config: ClicksignConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchWithTimeout(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const detail = body && typeof body === "object" && "errors" in body ? JSON.stringify((body as { errors: unknown }).errors) : `HTTP ${response.status}`;
    throw new Error(`Clicksign: ${detail}`);
  }
  return body as T;
}

export async function createClicksignEnvelope(config: ClicksignConfig, name: string) {
  const body = await clicksignRequest<{ data: JsonApiResource<{ status?: string }> }>(config, "/api/v3/envelopes", {
    method: "POST",
    body: JSON.stringify({ data: { type: "envelopes", attributes: { name } } }),
  });
  return { id: body.data.id, status: body.data.attributes?.status ?? "draft" };
}

export async function addClicksignDocument(config: ClicksignConfig, envelopeId: string, input: { filename: string; bytes: Buffer; contentType: string }) {
  const contentBase64 = `data:${input.contentType};base64,${input.bytes.toString("base64")}`;
  const body = await clicksignRequest<{ data: JsonApiResource }>(config, `/api/v3/envelopes/${encodeURIComponent(envelopeId)}/documents`, {
    method: "POST",
    body: JSON.stringify({ data: { type: "documents", attributes: { filename: input.filename, content_base64: contentBase64 } } }),
  });
  return { id: body.data.id };
}

export async function addClicksignSigner(config: ClicksignConfig, envelopeId: string, input: { name: string; email: string; documentation?: string | null }) {
  const body = await clicksignRequest<{ data: JsonApiResource }>(config, `/api/v3/envelopes/${encodeURIComponent(envelopeId)}/signers`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "signers",
        attributes: {
          name: input.name,
          email: input.email,
          has_documentation: Boolean(input.documentation),
          documentation: input.documentation || null,
          refusable: true,
          communicate_events: {
            signature_request: "email",
            signature_reminder: "email",
            document_signed: "email",
          },
        },
      },
    }),
  });
  return { id: body.data.id };
}

function requirementRelationships(documentId: string, signerId: string) {
  return {
    document: { data: { type: "documents", id: documentId } },
    signer: { data: { type: "signers", id: signerId } },
  };
}

export async function addClicksignRequirements(config: ClicksignConfig, envelopeId: string, documentId: string, signerId: string) {
  const path = `/api/v3/envelopes/${encodeURIComponent(envelopeId)}/requirements`;
  await clicksignRequest(config, path, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "requirements",
        attributes: { action: "agree", role: "buyer" },
        relationships: requirementRelationships(documentId, signerId),
      },
    }),
  });
  await clicksignRequest(config, path, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "requirements",
        attributes: { action: "provide_evidence", auth: "email" },
        relationships: requirementRelationships(documentId, signerId),
      },
    }),
  });
}

export async function activateClicksignEnvelope(config: ClicksignConfig, envelopeId: string) {
  const body = await clicksignRequest<{ data: JsonApiResource<{ status?: string }> }>(config, `/api/v3/envelopes/${encodeURIComponent(envelopeId)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { id: envelopeId, type: "envelopes", attributes: { status: "running" } } }),
  });
  return { status: body.data.attributes?.status ?? "running" };
}

export async function notifyClicksignEnvelope(config: ClicksignConfig, envelopeId: string) {
  await clicksignRequest(config, `/api/v3/envelopes/${encodeURIComponent(envelopeId)}/notifications`, {
    method: "POST",
    body: JSON.stringify({ data: { type: "notifications", attributes: { message: null } } }),
  });
}

export async function getClicksignEnvelope(config: ClicksignConfig, envelopeId: string) {
  const body = await clicksignRequest<{ data: JsonApiResource<{ status?: string; name?: string }> }>(config, `/api/v3/envelopes/${encodeURIComponent(envelopeId)}`);
  return { id: body.data.id, status: body.data.attributes?.status ?? null, name: body.data.attributes?.name ?? null };
}

export function verifyClicksignWebhook(rawBody: Buffer, signatureHeader: string | undefined, secret: string) {
  if (!signatureHeader || !secret) return false;
  const received = signatureHeader.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const left = Buffer.from(received, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
