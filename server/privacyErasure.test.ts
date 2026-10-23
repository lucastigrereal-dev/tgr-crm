import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV } from "./_core/env";
import { cpfHmac, erasureEventSchema } from "./privacyErasure";
import { isAllowedFeedEndpoint } from "./privacyErasureFeed";
import { domainEventDefinition } from "../shared/domainEvents";

const root = path.resolve(import.meta.dirname, "..");
const SECRET = "segredo-sintetico-so-para-teste";
const valid = { contractVersion: 1, eventId: "evt-00000001", type: "privacy.erasure.requested.v1", guestPassId: "GP-SYNTH0001", requestId: 7, mode: "minimal", keep: ["name", "cpf", "benefitDate"], requestedAt: "2026-10-23T12:00:00Z", fulfilledAt: "2026-10-23T12:05:00Z", subjectRefs: { cpfHmac: "a".repeat(64) } };

describe("F2.10: exclusão LGPD propagada, regras puras", () => {
  it("HMAC do CPF: só dígitos, só 11 dígitos, depende do segredo; CPF formatado e limpo dão o mesmo valor", () => {
    const a = cpfHmac("123.456.789-09", SECRET);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(cpfHmac("12345678909", SECRET)).toBe(a);
    expect(cpfHmac("12345678909", "outro-segredo")).not.toBe(a);
    expect(cpfHmac("12345678909", "")).toBeNull();
    expect(cpfHmac("1234567890", SECRET)).toBeNull();
    expect(cpfHmac(null, SECRET)).toBeNull();
    expect(a).not.toContain("12345678909");
  });
  it("contrato do evento: aceita o desenho e recusa o que foge dele", () => {
    expect(erasureEventSchema.safeParse(valid).success).toBe(true);
    for (const bad of [{ type: "outro.v1" }, { contractVersion: 2 }, { mode: "tudo" }, { subjectRefs: { cpfHmac: "123.456.789-09" } }, { subjectRefs: { cpfHmac: "A".repeat(64) } }, { subjectRefs: {} }, { eventId: "x" }, { keep: ["email"] }]) expect(erasureEventSchema.safeParse({ ...valid, ...bad }).success).toBe(false);
  });
  it("endpoint do feed: https; http só em localhost (teste)", () => {
    expect(isAllowedFeedEndpoint("https://guestpass.exemplo.test/api/integrations/privacy/erasures")).toBe(true);
    expect(isAllowedFeedEndpoint("http://127.0.0.1:9/x")).toBe(true);
    expect(isAllowedFeedEndpoint("http://guestpass.exemplo.test/x")).toBe(false);
    expect(isAllowedFeedEndpoint("")).toBe(false);
  });
});

describe("F2.10: nasce desligado, sem PII e sem entrega externa", () => {
  it("flag OFF no ENV, compose e .env.example; chaves e segredo vazios por padrão e fora da tela de flags", async () => {
    expect(ENV.privacyErasurePropagationEnabled).toBe(false);
    const compose = readFileSync(path.join(root, "infra/pilot/docker-compose.yml"), "utf8");
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    expect(compose).toContain('PRIVACY_ERASURE_PROPAGATION_ENABLED: "${PRIVACY_ERASURE_PROPAGATION_ENABLED:-false}"');
    expect(example).toMatch(/^PRIVACY_ERASURE_PROPAGATION_ENABLED=false/m);
    for (const name of ["GUESTPASS_PRIVACY_BRIDGE_ENDPOINT", "GUESTPASS_PRIVACY_BRIDGE_KEY", "GUESTPASS_PRIVACY_BRIDGE_HMAC_SECRET"]) {
      expect(compose).toContain(`${name}: "\${${name}:-}"`);
      expect(example).toMatch(new RegExp(`^${name}=\\s`, "m"));
    }
    const { FLAG_DENYLIST, isAllowedFlag } = await import("./featureFlags");
    for (const key of ["PRIVACY_ERASURE_PROPAGATION_ENABLED", "GUESTPASS_PRIVACY_BRIDGE_KEY", "GUESTPASS_PRIVACY_BRIDGE_HMAC_SECRET"]) { expect(FLAG_DENYLIST as readonly string[]).toContain(key); expect(isAllowedFlag(key)).toBe(false); }
  });
  it("evento interno fora das pontes e só com eventId e modo", async () => {
    const { toIntegrationEvent } = await import("../shared/integrationContract");
    const { FINANCIAL_EVENT_NAMES } = await import("./financialBridge");
    const { CONTRACT_STATE_EVENT_NAMES } = await import("./relationshipBridge");
    expect(domainEventDefinition("privacy.erasure.requested").aggregateType).toBe("privacy_erasure_event");
    expect((FINANCIAL_EVENT_NAMES as readonly string[]).includes("privacy.erasure.requested")).toBe(false);
    expect((CONTRACT_STATE_EVENT_NAMES as readonly string[]).includes("privacy.erasure.requested")).toBe(false);
    const event = toIntegrationEvent({ id: 1, eventName: "privacy.erasure.requested", aggregateType: "privacy_erasure_event", aggregateId: "1", actorUserId: null, occurredAt: new Date(0), payload: JSON.stringify({ eventId: "evt-1", mode: "minimal", cpf: "12345678909", cpfHmac: "a".repeat(64), name: "João" }) });
    expect(event.payload).toEqual({ eventId: "evt-1", mode: "minimal" });
  });
  it("o código não loga corpo, CPF nem HMAC e a migration segue só PROPOSTA", () => {
    for (const file of ["server/privacyErasure.ts", "server/privacyErasureFeed.ts", "server/privacyErasureJob.ts"]) {
      const source = readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/console\./);
      for (const call of source.match(/logger\.\w+\([^)]*\)/g) ?? []) expect(call, file).not.toMatch(/cpf|hmac|body|payload|raw/i);
    }
    expect(readdirSync(path.join(root, "drizzle")).filter(file => /privacy_erasure|propagation/i.test(file))).toEqual([]);
    expect(readdirSync(path.join(root, "migrations/proposed"))).toContain("PROPOSED_0088_privacy_erasure_propagation.sql");
  });
});
