import { describe, expect, it } from "vitest";
import { retryUnlessDefinitive } from "./queryRetry";

describe("retryUnlessDefinitive", () => {
  it("resposta definitiva do servidor não repete (a tela mostra o erro na hora)", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"]) expect(retryUnlessDefinitive(0, { data: { code } }), code).toBe(false);
  });
  it("falha transitória (rede, 5xx) continua repetindo até 3 vezes, como o padrão do react-query", () => {
    for (const error of [new Error("Failed to fetch"), { data: { code: "INTERNAL_SERVER_ERROR" } }, { data: { code: "TIMEOUT" } }, null, undefined]) {
      expect(retryUnlessDefinitive(0, error)).toBe(true);
      expect(retryUnlessDefinitive(2, error)).toBe(true);
      expect(retryUnlessDefinitive(3, error)).toBe(false);
    }
  });
});
