import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import {
  contractDocuments,
  contracts,
  contractSignatureDocuments,
  contractSignatureEnvelopes,
  contractSignatureSigners,
  customers,
  domainEvents,
  signatureWebhookEvents,
  users,
} from "../drizzle/schema";
import { validateIsolatedE2EDatabase } from "./e2eSafety";

// Reconciliação Clicksign local: webhook assinado por HMAC processado contra MySQL
// descartável. Nenhuma chamada de rede ao provedor; segredo gerado só para o teste.
const integrationUrl = process.env.TGR_MYSQL_INTEGRATION_URL;
const runId = randomUUID().slice(0, 8);
const webhookSecret = `kan31-local-${randomUUID()}`;

function sign(body: Buffer) {
  return createHmac("sha256", webhookSecret).update(body).digest("hex");
}

describe.skipIf(!integrationUrl)("Clicksign webhook em MySQL real: reconciliação local", () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzle>;
  let processClicksignWebhook: typeof import("./eSignatureService").processClicksignWebhook;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    validateIsolatedE2EDatabase(integrationUrl, previousEnv.DATABASE_URL);
    process.env.DATABASE_URL = integrationUrl;
    process.env.CLICKSIGN_API_TOKEN = "kan31-local-token-never-sent";
    process.env.CLICKSIGN_WEBHOOK_SECRET = webhookSecret;
    delete process.env.CLICKSIGN_API_URL;
    ({ processClicksignWebhook } = await import("./eSignatureService"));
    pool = mysql.createPool({ uri: integrationUrl, connectionLimit: 4 });
    db = drizzle({ client: pool });
  });

  afterAll(async () => {
    process.env = previousEnv;
    await pool?.end();
  });

  async function seedEnvelope(label: string) {
    const [user] = await db.insert(users).values({ openId: `kan31-${label}-${runId}`, name: "Admin KAN31", role: "admin" }).$returningId();
    const [customer] = await db.insert(customers).values({ fullName: `Cliente ${label} ${runId}`, status: "active" }).$returningId();
    const [contract] = await db.insert(contracts).values({ number: `KAN31-${label}-${runId}`, customerId: customer.id, status: "pending_signature", totalAmount: "1000.00" }).$returningId();
    const [document] = await db.insert(contractDocuments).values({ contractId: contract.id, category: "contrato", filename: "contrato.pdf", storageKey: `kan31/${label}.pdf` }).$returningId();
    const externalEnvelopeId = `env-${label}-${runId}`;
    const externalDocumentId = `doc-${label}-${runId}`;
    const externalSignerId = `sig-${label}-${runId}`;
    const [envelope] = await db.insert(contractSignatureEnvelopes).values({
      contractId: contract.id,
      externalEnvelopeId,
      activeKey: `contract:${contract.id}`,
      name: `Contrato ${label}`,
      status: "running",
      createdByUserId: user.id,
    }).$returningId();
    await db.insert(contractSignatureDocuments).values({ envelopeId: envelope.id, contractDocumentId: document.id, externalDocumentId });
    await db.insert(contractSignatureSigners).values({ envelopeId: envelope.id, customerId: customer.id, externalSignerId, name: "Cliente", email: "cliente@example.invalid" });
    return { contractId: contract.id, documentId: document.id, envelopeId: envelope.id, externalEnvelopeId, externalDocumentId, externalSignerId };
  }

  function payload(eventName: string, ids: { externalEnvelopeId: string; externalDocumentId: string; externalSignerId: string }, eventId = randomUUID()) {
    return Buffer.from(JSON.stringify({
      event: { id: eventId, name: eventName, occurred_at: "2026-10-04T15:00:00Z" },
      envelope: { id: ids.externalEnvelopeId },
      document: { id: ids.externalDocumentId },
      signer: { id: ids.externalSignerId },
    }));
  }

  it("rejeita payload sem HMAC válido sem gravar nada", async () => {
    const seeded = await seedEnvelope("hmac");
    const body = payload("sign", seeded);

    await expect(processClicksignWebhook(undefined, body)).resolves.toMatchObject({ status: 401 });
    await expect(processClicksignWebhook("0".repeat(64), body)).resolves.toMatchObject({ status: 401 });
    await expect(processClicksignWebhook(sign(Buffer.from("outro corpo")), body)).resolves.toMatchObject({ status: 401 });

    expect(await db.select().from(signatureWebhookEvents).where(eq(signatureWebhookEvents.externalEnvelopeId, seeded.externalEnvelopeId))).toHaveLength(0);
    const [document] = await db.select().from(contractDocuments).where(eq(contractDocuments.id, seeded.documentId));
    expect(document.signed).toBe(false);
  });

  it("assinatura e fechamento percorrem os estados, ativam o contrato e são idempotentes", async () => {
    const seeded = await seedEnvelope("flow");
    const signBody = payload("sign", seeded);

    await expect(processClicksignWebhook(`sha256=${sign(signBody)}`, signBody)).resolves.toMatchObject({ status: 200, eventName: "sign", linkedEnvelopeId: seeded.envelopeId, linkedContractId: seeded.contractId });
    await expect(processClicksignWebhook(sign(signBody), signBody)).resolves.toMatchObject({ status: 200, duplicate: true });

    const [signer] = await db.select().from(contractSignatureSigners).where(eq(contractSignatureSigners.externalSignerId, seeded.externalSignerId));
    expect(signer.status).toBe("signed");
    const [crmDocument] = await db.select().from(contractDocuments).where(eq(contractDocuments.id, seeded.documentId));
    expect(crmDocument.signed).toBe(true);
    let [contract] = await db.select().from(contracts).where(eq(contracts.id, seeded.contractId));
    expect(contract.status).toBe("pending_signature");

    const closeBody = payload("envelope_closed", seeded);
    await expect(processClicksignWebhook(sign(closeBody), closeBody)).resolves.toMatchObject({ status: 200, eventName: "envelope_closed" });
    await expect(processClicksignWebhook(sign(closeBody), closeBody)).resolves.toMatchObject({ status: 200, duplicate: true });

    const [envelope] = await db.select().from(contractSignatureEnvelopes).where(eq(contractSignatureEnvelopes.id, seeded.envelopeId));
    expect(envelope).toMatchObject({ status: "closed", activeKey: null, lastEventName: "envelope_closed" });
    [contract] = await db.select().from(contracts).where(eq(contracts.id, seeded.contractId));
    expect(contract.status).toBe("active");
    expect(contract.signedAt).toBeInstanceOf(Date);

    expect(await db.select().from(signatureWebhookEvents).where(eq(signatureWebhookEvents.externalEnvelopeId, seeded.externalEnvelopeId))).toHaveLength(2);
    const signedEvents = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "contract.document.signed"), eq(domainEvents.aggregateId, String(seeded.documentId))));
    expect(signedEvents).toHaveLength(1);
    const completed = await db.select().from(domainEvents).where(and(eq(domainEvents.eventName, "contract.signature.completed"), eq(domainEvents.aggregateId, String(seeded.contractId))));
    expect(completed).toHaveLength(1);
  });

  it("entrega duplicada simultânea grava o evento uma única vez", async () => {
    const seeded = await seedEnvelope("race");
    const body = payload("sign", seeded);

    const results = await Promise.all([processClicksignWebhook(sign(body), body), processClicksignWebhook(sign(body), body)]);

    expect(results.every(result => result.status === 200)).toBe(true);
    expect(results.filter(result => "duplicate" in result && result.duplicate)).toHaveLength(1);
    expect(await db.select().from(signatureWebhookEvents).where(eq(signatureWebhookEvents.externalEnvelopeId, seeded.externalEnvelopeId))).toHaveLength(1);
  });

  it("cancelamento encerra o envelope sem ativar o contrato", async () => {
    const seeded = await seedEnvelope("cancel");
    const body = payload("envelope_canceled", seeded);

    await expect(processClicksignWebhook(sign(body), body)).resolves.toMatchObject({ status: 200 });

    const [envelope] = await db.select().from(contractSignatureEnvelopes).where(eq(contractSignatureEnvelopes.id, seeded.envelopeId));
    expect(envelope).toMatchObject({ status: "canceled", activeKey: null });
    const [contract] = await db.select().from(contracts).where(eq(contracts.id, seeded.contractId));
    expect(contract.status).toBe("pending_signature");
  });
});
