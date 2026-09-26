import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  contractDocuments,
  contractSignatureDocuments,
  contractSignatureEnvelopes,
  contractSignatureSigners,
  contracts,
  customers,
  signatureWebhookEvents,
} from "../drizzle/schema";
import { getDb, recordAudit, recordDomainEvent } from "./db";
import {
  activateClicksignEnvelope,
  addClicksignDocument,
  addClicksignRequirements,
  addClicksignSigner,
  createClicksignEnvelope,
  getClicksignConfig,
  getClicksignEnvelope,
  notifyClicksignEnvelope,
  verifyClicksignWebhook,
} from "./clicksign";
import { storageReadBytes } from "./storage";

function contentTypeFor(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".doc")) return "application/msword";
  return "application/octet-stream";
}

function textAt(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function firstString(value: unknown, paths: string[][]) {
  for (const path of paths) {
    const candidate = textAt(value, path);
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function parseOccurredAt(value: unknown) {
  const candidate = firstString(value, [["event", "occurred_at"], ["occurred_at"], ["data", "occurred_at"]]);
  if (!candidate) return null;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isDuplicateKeyError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || Number(candidate.code) === 1062 || Number(candidate.errno) === 1062;
}

export async function startContractElectronicSignature(input: {
  actorUserId: number;
  contractId: number;
  contractDocumentId: number;
}) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const config = getClicksignConfig();
  if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Clicksign não configurada. Defina token, URL do ambiente e segredo do webhook." });

  const source = (await db.select({
    contract: contracts,
    customer: customers,
    document: contractDocuments,
  }).from(contracts)
    .innerJoin(customers, eq(contracts.customerId, customers.id))
    .innerJoin(contractDocuments, and(eq(contractDocuments.contractId, contracts.id), eq(contractDocuments.id, input.contractDocumentId)))
    .where(eq(contracts.id, input.contractId)).limit(1))[0];

  if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Contrato/documento não encontrado." });
  if (!source.customer.email) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "O associado precisa ter e-mail antes da assinatura eletrônica." });
  if (source.contract.status === "cancelled" || source.contract.status === "closed") throw new TRPCError({ code: "CONFLICT", message: "Contrato encerrado não pode iniciar assinatura." });
  if (source.document.signed) throw new TRPCError({ code: "CONFLICT", message: "Este documento já está marcado como assinado." });

  const active = (await db.select({
    envelope: contractSignatureEnvelopes,
    signatureDocument: contractSignatureDocuments,
  }).from(contractSignatureDocuments)
    .innerJoin(contractSignatureEnvelopes, eq(contractSignatureDocuments.envelopeId, contractSignatureEnvelopes.id))
    .where(and(
      eq(contractSignatureDocuments.contractDocumentId, input.contractDocumentId),
      inArray(contractSignatureEnvelopes.status, ["draft", "running"]),
    ))
    .orderBy(desc(contractSignatureEnvelopes.createdAt)).limit(1))[0];

  if (active) return {
    envelopeId: active.envelope.id,
    externalEnvelopeId: active.envelope.externalEnvelopeId,
    status: active.envelope.status,
    reused: true,
  };

  const bytes = await storageReadBytes(source.document.storageKey);
  const envelopeName = `Contrato ${source.contract.number} · ${source.customer.fullName}`;
  const remoteEnvelope = await createClicksignEnvelope(config, envelopeName);

  const localCreated = await db.insert(contractSignatureEnvelopes).values({
    contractId: input.contractId,
    provider: "clicksign",
    externalEnvelopeId: remoteEnvelope.id,
    name: envelopeName,
    status: "draft",
    createdByUserId: input.actorUserId,
  }).$returningId();
  const envelopeId = localCreated[0]?.id;
  if (!envelopeId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Envelope remoto criado, mas não foi possível registrar a assinatura localmente." });

  try {
    const remoteDocument = await addClicksignDocument(config, remoteEnvelope.id, {
      filename: source.document.filename,
      bytes,
      contentType: contentTypeFor(source.document.filename),
    });
    await db.insert(contractSignatureDocuments).values({
      envelopeId,
      contractDocumentId: input.contractDocumentId,
      externalDocumentId: remoteDocument.id,
      status: "pending",
    });

    const remoteSigner = await addClicksignSigner(config, remoteEnvelope.id, {
      name: source.customer.fullName,
      email: source.customer.email,
      documentation: source.customer.documentNumber || null,
    });
    await db.insert(contractSignatureSigners).values({
      envelopeId,
      customerId: source.customer.id,
      externalSignerId: remoteSigner.id,
      name: source.customer.fullName,
      email: source.customer.email,
      documentation: source.customer.documentNumber || null,
      status: "pending",
    });

    await addClicksignRequirements(config, remoteEnvelope.id, remoteDocument.id, remoteSigner.id);
    await activateClicksignEnvelope(config, remoteEnvelope.id);
    await notifyClicksignEnvelope(config, remoteEnvelope.id);

    const activatedAt = new Date();
    await db.transaction(async tx => {
      await tx.update(contractSignatureEnvelopes).set({ status: "running", activatedAt }).where(eq(contractSignatureEnvelopes.id, envelopeId));
      if (source.contract.status === "draft") {
        await tx.update(contracts).set({ status: "pending_signature" }).where(and(eq(contracts.id, input.contractId), eq(contracts.status, "draft")));
      }
    });

    await recordAudit(input.actorUserId, "contract_signature_envelope", envelopeId, "activated", `Envelope Clicksign ${remoteEnvelope.id} ativado para contrato ${source.contract.number}.`);
    await recordDomainEvent({ eventName: "contract.signature.started", aggregateType: "contract", aggregateId: input.contractId, actorUserId: input.actorUserId, payload: { contractId: input.contractId, contractDocumentId: input.contractDocumentId, provider: "clicksign", externalEnvelopeId: remoteEnvelope.id } });
    return { envelopeId, externalEnvelopeId: remoteEnvelope.id, status: "running" as const, reused: false };
  } catch (error) {
    await db.update(contractSignatureEnvelopes).set({ status: "error", lastEventName: "setup_failed", lastEventAt: new Date() }).where(eq(contractSignatureEnvelopes.id, envelopeId));
    await recordAudit(input.actorUserId, "contract_signature_envelope", envelopeId, "setup_failed", error instanceof Error ? error.message.slice(0, 1000) : "Falha desconhecida na integração Clicksign.");
    throw error;
  }
}

export async function reconcileContractSignature(input: { actorUserId: number; envelopeId: number }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Banco indisponível." });
  const config = getClicksignConfig();
  if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Clicksign não configurada." });
  const envelope = (await db.select().from(contractSignatureEnvelopes).where(eq(contractSignatureEnvelopes.id, input.envelopeId)).limit(1))[0];
  if (!envelope) throw new TRPCError({ code: "NOT_FOUND", message: "Envelope não encontrado." });
  if (envelope.provider !== "clicksign") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Provider de assinatura não suportado por este reconciliador." });
  const remote = await getClicksignEnvelope(config, envelope.externalEnvelopeId);
  const mapped = remote.status && ["draft", "running", "closed", "canceled"].includes(remote.status) ? remote.status as "draft" | "running" | "closed" | "canceled" : envelope.status;
  await db.update(contractSignatureEnvelopes).set({
    status: mapped,
    lastEventName: "manual_reconcile",
    lastEventAt: new Date(),
    closedAt: mapped === "closed" ? new Date() : envelope.closedAt,
    canceledAt: mapped === "canceled" ? new Date() : envelope.canceledAt,
  }).where(eq(contractSignatureEnvelopes.id, envelope.id));
  await recordAudit(input.actorUserId, "contract_signature_envelope", envelope.id, "reconciled", `Status remoto Clicksign: ${remote.status ?? "desconhecido"}.`);
  return { envelopeId: envelope.id, status: mapped, remoteStatus: remote.status };
}

export async function processClicksignWebhook(signatureHeader: string | undefined, rawBody: Buffer) {
  const config = getClicksignConfig();
  if (!config) return { status: 503 as const, message: "Clicksign não configurada." };
  if (!verifyClicksignWebhook(rawBody, signatureHeader, config.webhookSecret)) return { status: 401 as const, message: "Assinatura HMAC inválida." };

  let payload: unknown;
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch { return { status: 400 as const, message: "JSON inválido." }; }

  const eventName = firstString(payload, [["event", "name"], ["event_name"], ["name"]]) || "unknown";
  const occurredAt = parseOccurredAt(payload);
  const externalDocumentId = firstString(payload, [
    ["document", "id"], ["document", "key"], ["data", "document", "id"], ["data", "document", "key"],
  ]);
  const externalEnvelopeId = firstString(payload, [
    ["envelope", "id"], ["envelope", "key"], ["data", "envelope", "id"], ["data", "envelope", "key"],
    ["document", "envelope", "id"], ["document", "envelope", "key"],
  ]);
  const externalSignerId = firstString(payload, [
    ["signer", "id"], ["signer", "key"], ["data", "signer", "id"], ["data", "signer", "key"],
    ["event", "data", "signer", "id"], ["event", "data", "signer", "key"],
  ]);
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const eventKey = firstString(payload, [["event", "id"], ["event", "key"], ["id"]])
    || [eventName, occurredAt?.toISOString() ?? "", externalDocumentId ?? "", externalSignerId ?? "", payloadHash.slice(0, 16)].join(":");

  const db = await getDb();
  if (!db) return { status: 503 as const, message: "Banco indisponível." };
  const existing = (await db.select({ id: signatureWebhookEvents.id }).from(signatureWebhookEvents)
    .where(and(eq(signatureWebhookEvents.provider, "clicksign"), eq(signatureWebhookEvents.eventKey, eventKey))).limit(1))[0];
  if (existing) return { status: 200 as const, duplicate: true, message: "Evento já processado." };

  let linkedEnvelopeId: number | null = null;
  let linkedContractId: number | null = null;
  let signedContractDocumentId: number | null = null;

  try {
    await db.transaction(async tx => {
      let envelope = externalEnvelopeId ? (await tx.select().from(contractSignatureEnvelopes)
        .where(and(eq(contractSignatureEnvelopes.provider, "clicksign"), eq(contractSignatureEnvelopes.externalEnvelopeId, externalEnvelopeId))).limit(1).for("update"))[0] : null;

      const signatureDocument = externalDocumentId ? (await tx.select().from(contractSignatureDocuments)
        .where(eq(contractSignatureDocuments.externalDocumentId, externalDocumentId)).limit(1).for("update"))[0] : null;
      if (!envelope && signatureDocument) {
        envelope = (await tx.select().from(contractSignatureEnvelopes).where(eq(contractSignatureEnvelopes.id, signatureDocument.envelopeId)).limit(1).for("update"))[0];
      }
      linkedEnvelopeId = envelope?.id ?? null;
      linkedContractId = envelope?.contractId ?? null;

      await tx.insert(signatureWebhookEvents).values({
        provider: "clicksign",
        eventKey,
        eventName,
        externalEnvelopeId: externalEnvelopeId ?? envelope?.externalEnvelopeId ?? null,
        externalDocumentId,
        payloadHash,
        occurredAt,
      });

      const now = occurredAt ?? new Date();
      const signedEvents = new Set(["sign", "document_signed"]);
      const closedEvents = new Set(["close", "document_closed", "envelope_closed"]);
      const canceledEvents = new Set(["cancel", "document_canceled", "envelope_canceled", "envelope_cancelled"]);

      if (externalSignerId && signedEvents.has(eventName)) {
        await tx.update(contractSignatureSigners).set({ status: "signed", signedAt: now })
          .where(and(eq(contractSignatureSigners.externalSignerId, externalSignerId), eq(contractSignatureSigners.status, "pending")));
      }

      if (signatureDocument && (signedEvents.has(eventName) || closedEvents.has(eventName))) {
        await tx.update(contractSignatureDocuments).set({
          status: closedEvents.has(eventName) ? "closed" : "signed",
          signedAt: now,
          closedAt: closedEvents.has(eventName) ? now : undefined,
        }).where(eq(contractSignatureDocuments.id, signatureDocument.id));
        signedContractDocumentId = signatureDocument.contractDocumentId;
        await tx.update(contractDocuments).set({ signed: true }).where(eq(contractDocuments.id, signatureDocument.contractDocumentId));
      } else if (signatureDocument && canceledEvents.has(eventName)) {
        await tx.update(contractSignatureDocuments).set({ status: "canceled" }).where(eq(contractSignatureDocuments.id, signatureDocument.id));
      }

      if (envelope) {
        let nextStatus = envelope.status;
        if (eventName === "envelope_closed") nextStatus = "closed";
        else if (eventName === "envelope_canceled" || eventName === "envelope_cancelled") nextStatus = "canceled";
        else if (closedEvents.has(eventName)) {
          const docs = await tx.select({ status: contractSignatureDocuments.status }).from(contractSignatureDocuments)
            .where(eq(contractSignatureDocuments.envelopeId, envelope.id)).for("update");
          if (docs.length && docs.every(item => item.status === "closed" || (signatureDocument && item.status === "pending" && item === docs[0]))) {
            // Current TGR flow creates one document per envelope; the all-closed check remains safe when expanded.
            nextStatus = docs.length === 1 ? "closed" : nextStatus;
          }
        }
        await tx.update(contractSignatureEnvelopes).set({
          status: nextStatus,
          lastEventName: eventName,
          lastEventAt: now,
          closedAt: nextStatus === "closed" ? now : envelope.closedAt,
          canceledAt: nextStatus === "canceled" ? now : envelope.canceledAt,
        }).where(eq(contractSignatureEnvelopes.id, envelope.id));

        if (nextStatus === "closed") {
          await tx.update(contracts).set({ status: "active", signedAt: now, activatedAt: now })
            .where(and(eq(contracts.id, envelope.contractId), eq(contracts.status, "pending_signature")));
        }
      }
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) return { status: 200 as const, duplicate: true, message: "Evento já processado." };
    throw error;
  }

  if (linkedEnvelopeId) await recordAudit(null, "contract_signature_envelope", linkedEnvelopeId, `webhook_${eventName}`, `Webhook Clicksign processado: ${eventName}.`);
  if (signedContractDocumentId) await recordDomainEvent({ eventName: "contract.document.signed", aggregateType: "contract_document", aggregateId: signedContractDocumentId, actorUserId: null, payload: { contractId: linkedContractId } });
  if (linkedContractId && (eventName === "envelope_closed" || eventName === "document_closed" || eventName === "close")) {
    await recordDomainEvent({ eventName: "contract.signature.completed", aggregateType: "contract", aggregateId: linkedContractId, actorUserId: null, payload: { contractId: linkedContractId, provider: "clicksign", eventName } });
  }
  return { status: 200 as const, message: "Webhook processado.", eventName, linkedEnvelopeId, linkedContractId };
}
