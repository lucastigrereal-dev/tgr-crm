import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeStorageRead: vi.fn(),
  recordAudit: vi.fn(),
  createContext: vi.fn(),
  fetchWithTimeout: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./storageAccess", () => ({ authorizeStorageRead: mocks.authorizeStorageRead }));
vi.mock("./db", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("./_core/context", () => ({ createContext: mocks.createContext }));
vi.mock("./_core/env", () => ({ ENV: { forgeApiUrl: "https://forge.test", forgeApiKey: "test-key" } }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: mocks.fetchWithTimeout }));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn, error: mocks.error } }));

import { registerStorageProxy } from "./_core/storageProxy";

type Handler = (req: unknown, res: unknown) => Promise<void>;

type FakeResponse = {
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
};

function response(): FakeResponse {
  const res = {
    status: vi.fn(),
    send: vi.fn(),
    set: vi.fn(),
    redirect: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.set.mockReturnValue(res);
  return res;
}

describe("storage proxy", () => {
  let handler: Handler | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeStorageRead.mockResolvedValue({ allowed: true, scope: "contract", resourceId: 12 });
    mocks.createContext.mockResolvedValue({ user: { id: 7 } });
    mocks.fetchWithTimeout.mockResolvedValue({ ok: true, json: async () => ({ url: "https://signed.test/document.pdf" }) });
    const app = { get: vi.fn((_path: string, routeHandler: Handler) => { handler = routeHandler; }) };
    registerStorageProxy(app as never);
  });

  it("redireciona depois de falha de auditoria pós-presign sem transformar leitura em erro retriable", async () => {
    mocks.recordAudit.mockRejectedValue(new Error("database audit unavailable"));
    const res = response();

    await handler?.({ params: { splat: "contracts/12/document.pdf" } }, res);

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith("Storage read audit failed after presign", { error: "database audit unavailable" });
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.redirect).toHaveBeenCalledWith(307, "https://signed.test/document.pdf");
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });
});
