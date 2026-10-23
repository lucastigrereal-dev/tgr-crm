import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// F1.8: a tela não pode amarrar o passe quando ele já está em outra ficha (a criação falharia com CONFLICT) e mostra o selo "do GuestPass".
const source = readFileSync(path.resolve(import.meta.dirname, "../client/src/components/crm/GuestpassLookup.tsx"), "utf8");

describe("GuestpassLookup (contrato da tela)", () => {
  it("passe já ligado a outra ficha: avisa e NÃO chama onPassRef com o passe", () => {
    const branch = source.slice(source.indexOf("if (result.linkedCaptureId)"), source.indexOf("setFetchedAt(result.fetchedAt)"));
    expect(branch).toContain("onPassRef(null)");
    expect(branch).toContain("return;");
    expect(branch).not.toContain("result.passRef");
  });
  it("passe livre: amarra com a hora da busca e mostra o selo do GuestPass", () => {
    expect(source).toContain("onPassRef(result.passRef, result.fetchedAt)");
    expect(source).toContain('data-testid="guestpass-badge"');
  });
});
