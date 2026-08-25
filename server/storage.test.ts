import { describe, expect, it, vi } from "vitest";

vi.mock("./_core/env", () => ({
  ENV: { forgeApiUrl: "https://forge.test", forgeApiKey: "test-key" },
}));

import { storagePut } from "./storage";

describe("storage safety", () => {
  it.each(["../outside.txt", "folder/../../outside.txt", "folder\\..\\outside.txt", "./relative.txt", "unsafe\u0000key.txt"])("rejeita chave insegura: %s", async key => {
    await expect(storagePut(key, "content", "text/plain")).rejects.toThrow("Storage key inválida");
  });

  it("rejeita upload acima do limite antes de chamar o provider", async () => {
    await expect(storagePut("documents/large.bin", Buffer.alloc(50 * 1024 * 1024 + 1))).rejects.toThrow("Arquivo excede");
  });
});
