import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENCOUNTER_TIMES_PATH, encounterTimesHash, encounterTimesSchema } from "./encounterTimesReceiver";

// Contrato encounter.times_recorded.v1 (CRM-A21 / INT-10), lado CRM: a fixture versionada em docs/contracts/fixtures é a MESMA que
// o Sales Command deve usar para provar o emissor. Aqui o receptor é provado contra ela, sem banco (a rota HTTP com MySQL está em
// encounterTimesContract.mysql.test.ts). Mudou o contrato de forma incompatível? Novo v2 e novo arquivo, nunca editar o v1.
type Case = { name: string; expect: Record<string, unknown>; event: Record<string, unknown> };
const fixturePath = path.resolve(import.meta.dirname, "../docs/contracts/fixtures/encounter.times_recorded.v1.fixtures.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { contract: string; version: number; path: string; method: string; coupleCodeSeed: { valid: string; unknown: string }; valid: Case[]; invalid: Case[]; domainRefusals: Case[]; conflict: { basedOnValid: number; changes: { times: Record<string, unknown> } } };

describe("contrato encounter.times_recorded.v1: fixture compartilhada com o Sales Command", () => {
  it("a fixture descreve o contrato certo (nome, versão, rota e método)", () => {
    expect(fixture).toMatchObject({ contract: "encounter.times_recorded.v1", version: 1, method: "POST", path: ENCOUNTER_TIMES_PATH });
    expect(fixture.valid.length).toBeGreaterThanOrEqual(3);
    expect(fixture.invalid.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixture.valid.map(item => [item.name, item] as const))("válido: %s", (_name, item) => {
    const parsed = encounterTimesSchema.safeParse(item.event);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(item.event.eventName).toBe("encounter.times_recorded.v1");
    expect(item.event.coupleCode).toBe(fixture.coupleCodeSeed.valid);
  });

  it.each(fixture.invalid.map(item => [item.name, item] as const))("inválido (400): %s", (_name, item) => {
    expect(encounterTimesSchema.safeParse(item.event).success).toBe(false);
    expect(item.expect.status).toBe(400);
  });

  it("recusas de domínio têm corpo válido (a recusa é 422, não 400) e o código desconhecido da fixture", () => {
    for (const item of fixture.domainRefusals) {
      expect(encounterTimesSchema.safeParse(item.event).success).toBe(true);
      expect(item.event.coupleCode).toBe(fixture.coupleCodeSeed.unknown);
      expect(item.expect).toMatchObject({ status: 422, code: "UNKNOWN_COUPLE_CODE" });
    }
  });

  it("eventIds da fixture são únicos e o conflito muda o conteúdo (hash diferente) com o mesmo eventId", () => {
    const ids = [...fixture.valid, ...fixture.invalid, ...fixture.domainRefusals].map(item => item.event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    const original = encounterTimesSchema.parse(fixture.valid[fixture.conflict.basedOnValid]!.event);
    const changed = encounterTimesSchema.parse({ ...original, times: fixture.conflict.changes.times });
    expect(changed.eventId).toBe(original.eventId);
    expect(encounterTimesHash(changed)).not.toBe(encounterTimesHash(original));
  });

  it("o hash do replay ignora a ordem das chaves do JSON (o Sales pode serializar em qualquer ordem)", () => {
    const event = encounterTimesSchema.parse(fixture.valid[0]!.event);
    const reordered = encounterTimesSchema.parse(JSON.parse(JSON.stringify({ times: Object.fromEntries(Object.entries(fixture.valid[0]!.event.times as object).reverse()), coupleCode: event.coupleCode, occurredAt: event.occurredAt, correlationId: event.correlationId, source: event.source, eventName: event.eventName, eventId: event.eventId })));
    expect(encounterTimesHash(reordered)).toBe(encounterTimesHash(event));
  });

  it("a fixture só tem dado sintético: nada de CPF, e-mail, telefone ou nome de pessoa", () => {
    const text = readFileSync(fixturePath, "utf8");
    expect(text).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}|@[a-z0-9-]+\.[a-z]{2,}|\(\d{2}\)\s?\d{4,5}-\d{4}/i);
  });
});
