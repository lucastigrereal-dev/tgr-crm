import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  recordAudit: vi.fn(),
  recordDomainEvent: vi.fn(),
}));
const clicksignMocks = vi.hoisted(() => ({
  getClicksignConfig: vi.fn(),
  verifyClicksignWebhook: vi.fn(),
  createClicksignEnvelope: vi.fn(),
  addClicksignDocument: vi.fn(),
  addClicksignSigner: vi.fn(),
  addClicksignRequirements: vi.fn(),
  activateClicksignEnvelope: vi.fn(),
  notifyClicksignEnvelope: vi.fn(),
  getClicksignEnvelope: vi.fn(),
}));
const storageMocks = vi.hoisted(() => ({ storageReadBytes: vi.fn() }));

vi.mock("./db", () => dbMocks);
vi.mock("./clicksign", () => clicksignMocks);
vi.mock("./storage", () => storageMocks);

import { processClicksignWebhook, startContractElectronicSignature } from "./eSignatureService";

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) promise[method] = () => promise;
  promise.for = async () => value;
  return promise;
}

describe("electronic signature service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clicksignMocks.getClicksignConfig.mockReturnValue({ token: "token", webhookSecret: "secret", baseUrl: "https://sandbox.clicksign.com" });
  });

  it("rejects an invalid webhook HMAC before touching the database", async () => {
    clicksignMocks.verifyClicksignWebhook.mockReturnValue(false);

    await expect(processClicksignWebhook("bad", Buffer.from("{}"))).resolves.toEqual({
      status: 401,
      message: "Assinatura HMAC inválida.",
    });
    expect(dbMocks.getDb).not.toHaveBeenCalled();
  });

  it("acks a duplicate provider event without replaying its effects", async () => {
    clicksignMocks.verifyClicksignWebhook.mockReturnValue(true);
    const transaction = vi.fn();
    dbMocks.getDb.mockResolvedValue({
      select: vi.fn(() => chain([{ id: 991 }])),
      transaction,
    });

    const payload = Buffer.from(JSON.stringify({
      event: { id: "evt-001", name: "document_closed", occurred_at: "2026-09-26T18:00:00.000Z" },
      document: { id: "doc-001" },
    }));

    await expect(processClicksignWebhook("valid", payload)).resolves.toMatchObject({
      status: 200,
      duplicate: true,
      message: "Evento já processado.",
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(dbMocks.recordAudit).not.toHaveBeenCalled();
  });

  it("reuses the active local claim instead of creating a second remote envelope", async () => {
    const source = {
      contract: { id: 10, number: "NAT-10", status: "draft" },
      customer: { id: 20, fullName: "Ana & Bruno", email: "ana@example.com", documentNumber: "123" },
      document: { id: 30, filename: "contrato.pdf", storageKey: "contracts/10/file.pdf", signed: false },
    };
    const active = {
      id: 40,
      contractId: 10,
      provider: "clicksign",
      externalEnvelopeId: "env-existing",
      activeKey: "contract-document:30",
      status: "running",
    };
    let selectCall = 0;
    dbMocks.getDb.mockResolvedValue({
      select: vi.fn(() => chain(selectCall++ === 0 ? [source] : [active])),
    });

    await expect(startContractElectronicSignature({ actorUserId: 7, contractId: 10, contractDocumentId: 30 }))
      .resolves.toMatchObject({ envelopeId: 40, externalEnvelopeId: "env-existing", status: "running", reused: true });

    expect(storageMocks.storageReadBytes).not.toHaveBeenCalled();
    expect(clicksignMocks.createClicksignEnvelope).not.toHaveBeenCalled();
  });
});
