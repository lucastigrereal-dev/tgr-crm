import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({ startContractElectronicSignature: vi.fn(), reconcileContractSignature: vi.fn() }));
vi.mock("./eSignatureService", () => service);
vi.mock("./db", () => ({ getDb: vi.fn() }));

import { electronicSignaturesRouter } from "./routers/electronicSignatures";

describe("permissões da assinatura eletrônica", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["seller", "finance", "service"] as const)("%s não envia nem reconcilia envelope", async role => {
    const caller = electronicSignaturesRouter.createCaller({ user: { id: 9, role } } as never);

    await expect(caller.start({ contractId: 1, contractDocumentId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.reconcile({ envelopeId: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(service.startContractElectronicSignature).not.toHaveBeenCalled();
    expect(service.reconcileContractSignature).not.toHaveBeenCalled();
  });

  it("admin envia e reconcilia", async () => {
    service.startContractElectronicSignature.mockResolvedValue({ envelopeId: 3 });
    service.reconcileContractSignature.mockResolvedValue({ status: "running" });
    const caller = electronicSignaturesRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

    await expect(caller.start({ contractId: 1, contractDocumentId: 2 })).resolves.toEqual({ envelopeId: 3 });
    await expect(caller.reconcile({ envelopeId: 3 })).resolves.toEqual({ status: "running" });
    expect(service.startContractElectronicSignature).toHaveBeenCalledWith({ actorUserId: 1, contractId: 1, contractDocumentId: 2 });
  });
});
