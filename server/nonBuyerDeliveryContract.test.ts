import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eligibleBodySchema, revokedBodySchema } from "../shared/nonBuyerDeliveryContract";
import { backoffMs, dedupeKeyOf, encounterDateIn, isAllowedDeliveryEndpoint, RETRY_CAP_MS } from "./nonBuyerDelivery";

const fixtures = JSON.parse(readFileSync(path.resolve(__dirname, "../docs/contracts/fixtures/crm.non_buyer.v1.fixtures.json"), "utf8"));

describe("F2.1: contrato de entrega crm.non_buyer.*.v1 (fixture sintética)", () => {
  it("todo caso válido da fixture passa no schema estrito", () => {
    for (const item of fixtures.eligible.valid) expect(eligibleBodySchema.safeParse(item.event).success, item.name).toBe(true);
    for (const item of fixtures.revoked.valid) expect(revokedBodySchema.safeParse(item.event).success, item.name).toBe(true);
  });
  it("todo caso inválido da fixture (mutação do primeiro válido) é recusado", () => {
    for (const item of fixtures.eligible.invalid) expect(eligibleBodySchema.safeParse({ ...fixtures.eligible.valid[0].event, ...item.mutate }).success, item.name).toBe(false);
    for (const item of fixtures.revoked.invalid) expect(revokedBodySchema.safeParse({ ...fixtures.revoked.valid[0].event, ...item.mutate }).success, item.name).toBe(false);
  });
  it("a fixture não carrega CPF, e-mail nem campos fora da whitelist do corpo de revogação (sem PII)", () => {
    expect(JSON.stringify(fixtures.revoked.valid)).not.toMatch(/Casal|phone|contact|cpf/i);
    expect(Object.keys(fixtures.revoked.valid[0].event).sort()).toEqual(["coupleCode", "dedupeKey", "encounterDate", "eventId", "reason", "revokedAt", "source"]);
  });
  it("não altera os contratos travados: a seção nova não está no lock nem no snapshot", () => {
    const lock = readFileSync(path.resolve(__dirname, "../shared/contracts/consumers.lock.json"), "utf8");
    const snapshot = readFileSync(path.resolve(__dirname, "../shared/contracts/tgr-events.snapshot.json"), "utf8");
    expect(lock + snapshot).not.toContain("crm.non_buyer.v1.fixtures");
    expect(JSON.parse(snapshot).recovery?.nonBuyerDelivery).toBeUndefined();
  });
});

describe("F2.1: chave de dedupe, data do encontro e backoff", () => {
  it("a data do encontro vem do fuso do projeto (02:30Z em Recife ainda é o dia anterior)", () => {
    expect(encounterDateIn(new Date("2026-10-22T02:30:00Z"), "America/Recife")).toBe("2026-10-21");
    expect(encounterDateIn(new Date("2026-10-22T03:00:00Z"), "America/Recife")).toBe("2026-10-22");
    expect(encounterDateIn(new Date("2026-10-22T02:30:00Z"), "Fuso/Inexistente")).toBe("2026-10-21"); // cai no fuso padrão
    expect(dedupeKeyOf("CP-1", "2026-10-21")).toBe("CP-1:2026-10-21");
  });
  it("backoff dobra a partir de 5 s e para em 10 min", () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([5_000, 10_000, 20_000]);
    expect(backoffMs(30)).toBe(RETRY_CAP_MS);
  });
  it("endpoint: https, ou http só em localhost", () => {
    expect(isAllowedDeliveryEndpoint("https://recovery.example")).toBe(true);
    expect(isAllowedDeliveryEndpoint("http://127.0.0.1:9")).toBe(true);
    expect(isAllowedDeliveryEndpoint("http://recovery.example")).toBe(false);
    expect(isAllowedDeliveryEndpoint("")).toBe(false);
  });
});
