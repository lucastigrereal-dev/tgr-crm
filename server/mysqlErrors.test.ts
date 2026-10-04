import { describe, expect, it } from "vitest";
import { isDuplicateKeyError } from "./mysqlErrors";

describe("isDuplicateKeyError", () => {
  it("reconhece o erro direto do mysql2", () => {
    expect(isDuplicateKeyError({ code: "ER_DUP_ENTRY", errno: 1062 })).toBe(true);
    expect(isDuplicateKeyError({ errno: 1062 })).toBe(true);
  });

  it("reconhece o erro embrulhado pelo drizzle em cause", () => {
    const original = Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 });
    expect(isDuplicateKeyError(new Error("Failed query: insert ...", { cause: original }))).toBe(true);
    expect(isDuplicateKeyError(new Error("outer", { cause: new Error("Failed query", { cause: original }) }))).toBe(true);
  });

  it("não confunde outros erros com chave duplicada", () => {
    expect(isDuplicateKeyError(new Error("Failed query", { cause: { code: "ER_LOCK_DEADLOCK", errno: 1213 } }))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError("ER_DUP_ENTRY")).toBe(false);
  });
});
