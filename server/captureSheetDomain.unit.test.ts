import { describe, expect, it } from "vitest";
import { arrivalOrder, isCoupleCode, relationshipDays } from "./captureSheetDomain";

describe("ficha impressa: regras puras", () => {
  it("aceita código do casal curto e seguro e recusa lixo, CPF e telefone", () => {
    expect(isCoupleCode("AB12-cd_34")).toBe(true);
    expect(isCoupleCode("abc")).toBe(false);
    expect(isCoupleCode("a b c d")).toBe(false);
    expect(isCoupleCode("12345678901")).toBe(false);
    expect(isCoupleCode("81-99999-9999")).toBe(false);
    expect(isCoupleCode("999998888")).toBe(false);
    expect(isCoupleCode("CP-0001")).toBe(true);
    expect(isCoupleCode("x".repeat(65))).toBe(false);
    expect(isCoupleCode("../etc/passwd")).toBe(false);
  });

  it("tempo de relacionamento em dias sai de anos e meses, vazio quando não informado", () => {
    expect(relationshipDays(null, null)).toBeNull();
    expect(relationshipDays(2, 3)).toBe(2 * 365 + 90);
    expect(relationshipDays(null, 6)).toBe(180);
  });

  it("ordem de chegada conta os check-ins anteriores do dia e desempata pelo id", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 17, h));
    const rows = [{ id: 3, checkedInAt: at(10) }, { id: 1, checkedInAt: at(9) }, { id: 2, checkedInAt: at(9) }, { id: 4, checkedInAt: null }];
    expect(arrivalOrder(rows[1], rows)).toBe(1);
    expect(arrivalOrder(rows[2], rows)).toBe(2);
    expect(arrivalOrder(rows[0], rows)).toBe(3);
    expect(arrivalOrder(rows[3], rows)).toBeNull();
  });
});
