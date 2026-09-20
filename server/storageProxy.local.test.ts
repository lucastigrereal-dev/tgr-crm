import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeStorageRead: vi.fn(),
  recordAudit: vi.fn(),
  createContext: vi.fn(),
  getLocalStorageRoot: vi.fn(),
  readLocalStorageFile: vi.fn(),
  fetchWithTimeout: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./storageAccess", () => ({ authorizeStorageRead: mocks.authorizeStorageRead }));
vi.mock("./db", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("./_core/context", () => ({ createContext: mocks.createContext }));
vi.mock("./localStorage", () => ({
  getLocalStorageRoot: mocks.getLocalStorageRoot,
  readLocalStorageFile: mocks.readLocalStorageFile,
}));
vi.mock("./_core/env", () => ({ ENV: { forgeApiUrl: "", forgeApiKey: "" } }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: mocks.fetchWithTimeout }));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn, error: mocks.error } }));

import { registerStorageProxy } from "./_core/storageProxy";

type Handler = (req: any, res: any) => Promise<void>;
describe("local storage proxy", () => {
  let handler: Handler | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocalStorageRoot.mockReturnValue("C:/private");
    mocks.readLocalStorageFile.mockResolvedValue(Buffer.from("documento"));
    mocks.authorizeStorageRead.mockResolvedValue({
      allowed: true,
      scope: "contract",
      resourceId: 12,
    });
    mocks.createContext.mockResolvedValue({ user: { id: 7 } });

    const app = {
      get: vi.fn((_path: string, routeHandler: Handler) => {
        handler = routeHandler;
      }),
    };
    registerStorageProxy(app as never);
  });

  it("entrega arquivo local apenas depois da autorização e auditoria", async () => {
    const res: any = {
      status: vi.fn(),
      send: vi.fn(),
      set: vi.fn(),
    };
    res.status.mockReturnValue(res);
    res.set.mockReturnValue(res);

    await handler?.({ params: { splat: ["contracts", "12", "signed.pdf"] } }, res);

    expect(mocks.authorizeStorageRead).toHaveBeenCalled();
    expect(mocks.readLocalStorageFile).toHaveBeenCalledWith("contracts/12/signed.pdf");
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      7,
      "contract_document",
      12,
      "read",
      "Documento local acessado por usuário autenticado.",
    );
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(Buffer.from("documento"));
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });
});
