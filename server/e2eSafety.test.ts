import { describe, expect, it } from "vitest";
import { validateIsolatedE2EDatabase } from "./e2eSafety";
describe("trava de homologação E2E", () => {
  it("aceita somente banco explicitamente isolado", () => expect(validateIsolatedE2EDatabase("mysql://user:pass@db.example.com/tse_e2e")).toEqual({ host: "db.example.com", database: "tse_e2e" }));
  it("bloqueia URL operacional e nome sem sufixo", () => { expect(() => validateIsolatedE2EDatabase("mysql://user:pass@db.example.com/tse_prod", "mysql://user:pass@db.example.com/tse_prod")).toThrow(/operacional/); expect(() => validateIsolatedE2EDatabase("mysql://user:pass@db.example.com/tse_prod")).toThrow(/_e2e/); });
});
