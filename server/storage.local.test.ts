import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/env", () => ({
  ENV: { forgeApiUrl: "", forgeApiKey: "" },
}));

import { storageGetSignedUrl, storagePut } from "./storage";
import { resolveLocalStoragePath } from "./localStorage";

describe("local private storage", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tgr-local-storage-"));
    vi.stubEnv("LOCAL_STORAGE_DIRECTORY", directory);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("grava conteúdo no diretório privado e mantém URL autenticada", async () => {
    const result = await storagePut(
      "contracts/12/contrato.txt",
      "conteudo-teste",
      "text/plain",
    );

    expect(result.key).toMatch(/^contracts\/12\/contrato_[0-9a-f]{8}\.txt$/);
    expect(result.url).toBe(`/manus-storage/${result.key}`);
    expect(await readFile(resolveLocalStoragePath(result.key), "utf8")).toBe("conteudo-teste");
    expect(await storageGetSignedUrl(result.key)).toBe(`/manus-storage/${result.key}`);
  });

  it("continua rejeitando traversal de caminho", async () => {
    await expect(storagePut("../fora.txt", "x")).rejects.toThrow("Storage key inválida");
  });
});
