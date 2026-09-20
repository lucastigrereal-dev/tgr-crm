import { expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMock.getDb,
}));

import { authorizeStorageRead } from "./storageAccess";

const seller = { id: 10, role: "seller" as const };

function mockDocumentQuery(rows: Array<{ id: number }>) {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return { select: vi.fn(() => query) };
}

it("recusa leitura de storage sem autenticação", async () => {
  const result = await authorizeStorageRead(null, "customers/1/document.pdf");
  expect(result).toEqual({
    allowed: false,
    status: 401,
    reason: "unauthenticated",
  });
  expect(dbMock.getDb).not.toHaveBeenCalled();
});

it("recusa papel que não é interno", async () => {
  const result = await authorizeStorageRead(
    { id: 11, role: "user" as const },
    "customers/1/document.pdf",
  );
  expect(result.status).toBe(403);
  expect(result.reason).toBe("forbidden");
});

it("recusa chave válida que não está registrada no recurso", async () => {
  dbMock.getDb.mockResolvedValueOnce(mockDocumentQuery([]));
  const result = await authorizeStorageRead(
    seller,
    "customers/999/document.pdf",
  );
  expect(result).toEqual({
    allowed: false,
    status: 403,
    reason: "forbidden",
  });
});

it("permite documento registrado no CRM para usuário interno", async () => {
  dbMock.getDb.mockResolvedValueOnce(mockDocumentQuery([{ id: 42 }]));
  const result = await authorizeStorageRead(
    seller,
    "contracts/12/signed.pdf",
  );
  expect(result).toEqual({
    allowed: true,
    scope: "contract",
    resourceId: 12,
  });
});

it("não permite presign quando a autorização não consegue consultar o banco", async () => {
  dbMock.getDb.mockResolvedValueOnce(null);
  const result = await authorizeStorageRead(
    seller,
    "customers/1/document.pdf",
  );
  expect(result).toEqual({
    allowed: false,
    status: 503,
    reason: "authorization_unavailable",
  });
});
