import { beforeEach, describe, expect, it, vi } from "vitest";
import { contractDocuments } from "../drizzle/schema";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
const storageMocks = vi.hoisted(() => ({ storagePut: vi.fn(async (key: string) => ({ key, url: `/manus-storage/${key}` })) }));
vi.mock("./db", () => dbMocks);
vi.mock("./storage", () => storageMocks);

import { contractsRouter } from "./routers/contracts";

const BASE64 = "data:application/pdf;base64,MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=";

function makeDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => { const chain: Record<string, unknown> = {}; Object.assign(chain, { from: () => chain, where: () => chain, limit: async () => [{ id: 701, contractId: 701, signed: false }] }); return chain; });
  const insert = vi.fn((table: unknown) => ({ values: vi.fn((values: Record<string, unknown>) => { if (table === contractDocuments) inserted.push(values); return { $returningId: async () => [{ id: 702 }] }; }) }));
  const update = vi.fn(() => ({ set: vi.fn((values: Record<string, unknown>) => { updates.push(values); return { where: vi.fn(async () => ({ affectedRows: 1 })) }; }) }));
  return { db: { select, insert, update }, inserted, updates };
}

describe("signedArtifact: só upload de admin com arquivo assinado cria artefato assinado", () => {
  beforeEach(() => vi.clearAllMocks());

  it("admin com signed:true: bytes vão ao storage e a linha nasce signedArtifact=true", async () => {
    const ctx = makeDb(); dbMocks.getDb.mockResolvedValue(ctx.db);
    await contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never).uploadDocument({ contractId: 701, category: "Contrato assinado", filename: "assinado.pdf", contentType: "application/pdf", signed: true, base64: BASE64 });
    expect(storageMocks.storagePut).toHaveBeenCalledTimes(1);
    expect(ctx.inserted[0]).toMatchObject({ signed: true, signedArtifact: true, storageKey: expect.stringContaining("contracts/701/") });
  });

  it("papel comercial com signed:true: flag ignorada, nenhum artefato assinado", async () => {
    const ctx = makeDb(); dbMocks.getDb.mockResolvedValue(ctx.db);
    await contractsRouter.createCaller({ user: { id: 56, role: "seller" } } as never).uploadDocument({ contractId: 701, category: "Contrato assinado", filename: "x.pdf", contentType: "application/pdf", signed: true, base64: BASE64 });
    expect(ctx.inserted[0]).toMatchObject({ signed: false, signedArtifact: false });
  });

  it("upload sem signed: rascunho (signedArtifact=false)", async () => {
    const ctx = makeDb(); dbMocks.getDb.mockResolvedValue(ctx.db);
    await contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never).uploadDocument({ contractId: 701, category: "Contrato", filename: "rascunho.pdf", contentType: "application/pdf", signed: false, base64: BASE64 });
    expect(ctx.inserted[0]).toMatchObject({ signed: false, signedArtifact: false });
  });

  it("markDocumentSigned marca só `signed` (exibição); nunca signedArtifact", async () => {
    const ctx = makeDb(); dbMocks.getDb.mockResolvedValue(ctx.db);
    await contractsRouter.createCaller({ user: { id: 55, role: "admin" } } as never).markDocumentSigned({ documentId: 702 });
    expect(ctx.updates).toEqual([{ signed: true }]);
  });
});
