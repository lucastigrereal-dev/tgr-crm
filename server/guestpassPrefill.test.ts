import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePassRef, resolveGuestpassConfig } from "./guestpassConfig";
import { fetchGuestpassPrefill, prefillToFormFields } from "./guestpassPrefill";
import { applyGuestpassFields } from "../client/src/lib/guestpassForm";

// F1.8 / CRM-a: o CRM consome guestpass.prefill.v1 conforme a fixture do GuestPass (copiada fielmente da Suite #148). Dados 100% sintéticos.
const fixturePath = path.resolve(import.meta.dirname, "../docs/contracts/fixtures/guestpass_prefill_contract.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const PASS = "GP-0A1B2C3D4E";
const KEY = "chave-ponte-sintetica";
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers }));

describe("fixture do contrato guestpass.prefill.v1 (travada por hash)", () => {
  it("o conteúdo (sem _source) é o da Suite #148: mudou = o GuestPass muda primeiro, depois a Suite, depois aqui", () => {
    const { _source, ...content } = fixture;
    expect(_source).toContain("tgr-guestpass");
    expect(createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex")).toBe("01580fcdd4169174e8629512914917e8709a0bc719ad5cb033484698b438aafa");
  });
  it("o exemplo da fixture é aceito, só tem as chaves da lista fechada e nenhuma proibida", async () => {
    vi.stubEnv("CRM_GUESTPASS_PREFILL_ENABLED", "true"); vi.stubEnv("GUESTPASS_CRM_BASE_URL", "https://gp.example.test"); vi.stubEnv("GUESTPASS_CRM_READ_KEY", KEY);
    expect(Object.keys(fixture.example).sort()).toEqual([...fixture.responseKeys].sort());
    expect(Object.keys(fixture.example.couple).sort()).toEqual([...fixture.coupleKeys].sort());
    const result = await fetchGuestpassPrefill(fixture.example.guestPassId, reply(200, fixture.example) as never);
    expect(result.kind).toBe("ok");
    vi.unstubAllEnvs();
  });
});

describe("configuração", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("flag desligada por padrão; ligada sem base ou sem chave = não configurada; ligada com os dois = configurada", () => {
    expect(resolveGuestpassConfig()).toEqual({ enabled: false });
    vi.stubEnv("CRM_GUESTPASS_PREFILL_ENABLED", "true");
    expect(resolveGuestpassConfig()).toEqual({ enabled: true, configured: false });
    vi.stubEnv("GUESTPASS_CRM_BASE_URL", "https://gp.example.test/");
    expect(resolveGuestpassConfig()).toEqual({ enabled: true, configured: false });
    vi.stubEnv("GUESTPASS_CRM_READ_KEY", KEY);
    expect(resolveGuestpassConfig()).toMatchObject({ enabled: true, configured: true, baseUrl: "https://gp.example.test", timeoutMs: 5000 });
    for (const bad of ["ftp://x", "http://gp.example.test", "http://10.0.0.5:8080", "http://gp.localhost.evil.test"]) {
      vi.stubEnv("GUESTPASS_CRM_BASE_URL", bad);
      expect(resolveGuestpassConfig()).toEqual({ enabled: true, configured: false });
    }
    for (const ok of ["http://127.0.0.1:4010", "http://localhost:4010/api"]) {
      vi.stubEnv("GUESTPASS_CRM_BASE_URL", ok);
      expect(resolveGuestpassConfig()).toMatchObject({ enabled: true, configured: true });
    }
  });
  it("normaliza o Nº do passe e recusa fora do padrão", () => {
    expect(normalizePassRef(" gp-0a1b2c3d ")).toBe("GP-0A1B2C3D");
    expect(normalizePassRef(PASS)).toBe(PASS);
    for (const bad of ["", "GP-123", "GP-0A1B2C3D4", "GP-0A1B2C3D4EF", "XX-0A1B2C3D", "GP-0A1B2C3G", "../GP-0A1B2C3D", null, 12]) expect(normalizePassRef(bad)).toBeNull();
  });
});

describe("consulta ao GuestPass", () => {
  beforeEach(() => { vi.stubEnv("CRM_GUESTPASS_PREFILL_ENABLED", "true"); vi.stubEnv("GUESTPASS_CRM_BASE_URL", "https://gp.example.test"); vi.stubEnv("GUESTPASS_CRM_READ_KEY", KEY); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("pede GET na rota do contrato com a chave de ponte como Bearer (não o token de CI) e devolve os campos", async () => {
    const fetchImpl = reply(200, fixture.example);
    const result = await fetchGuestpassPrefill(PASS, fetchImpl as never);
    expect(result.kind).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://gp.example.test${fixture.route.replace("{guestPassId}", PASS)}`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    if (result.kind === "ok") expect(prefillToFormFields(result.prefill)).toEqual({ fullName: "EXEMPLO Titular", partnerName: "EXEMPLO Acompanhante", phone: "8400000000", city: "Cidade Exemplo", state: "UF", lodgingLocation: "Hospedagem Exemplo", captureLocation: "PONTA-NEGRA", visitDate: "2026-10-02" });
  });

  it("flag desligada ou sem chave: não chama a rede", async () => {
    const fetchImpl = reply(200, fixture.example);
    vi.stubEnv("GUESTPASS_CRM_READ_KEY", "");
    expect((await fetchGuestpassPrefill(PASS, fetchImpl as never)).kind).toBe("not_configured");
    vi.stubEnv("CRM_GUESTPASS_PREFILL_ENABLED", "false");
    expect((await fetchGuestpassPrefill(PASS, fetchImpl as never)).kind).toBe("not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([[404, "not_found"], [401, "unauthorized"], [500, "unavailable"], [503, "unavailable"], [302, "unavailable"]] as const)("HTTP %i vira %s", async (status, kind) => {
    expect((await fetchGuestpassPrefill(PASS, reply(status, { code: "X" }) as never)).kind).toBe(kind);
  });
  it("429 respeita o Retry-After do contrato (1 a 60 s); valor fora disso é ignorado", async () => {
    expect(await fetchGuestpassPrefill(PASS, reply(429, { code: "RATE_LIMITED" }, { "retry-after": "17" }) as never)).toEqual({ kind: "rate_limited", retryAfterSeconds: 17 });
    expect(await fetchGuestpassPrefill(PASS, reply(429, { code: "RATE_LIMITED" }, { "retry-after": "9999" }) as never)).toEqual({ kind: "rate_limited" });
  });
  it("falha de rede ou tempo esgotado: indisponível, sem lançar", async () => {
    expect((await fetchGuestpassPrefill(PASS, vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as never)).kind).toBe("unavailable");
  });

  it("campo PROIBIDO pelo contrato (cpf, renda, veículo, notas...) em qualquer nível descarta a resposta inteira", async () => {
    for (const forbidden of fixture.forbiddenKeys as string[]) {
      const top = { ...fixture.example, [forbidden]: "x" };
      const nested = { ...fixture.example, couple: { ...fixture.example.couple, [forbidden]: "x" } };
      expect((await fetchGuestpassPrefill(PASS, reply(200, top) as never)).kind).toBe("invalid_response");
      expect((await fetchGuestpassPrefill(PASS, reply(200, nested) as never)).kind).toBe("invalid_response");
    }
  });
  it("campo desconhecido, versão diferente, status fora dos aceitos ou passe diferente do pedido: resposta inválida", async () => {
    const bads = [{ ...fixture.example, extra: 1 }, { ...fixture.example, contractVersion: 2 }, { ...fixture.example, status: "cancelled" }, { ...fixture.example, guestPassId: "GP-FFFFFFFFFF" }, { ...fixture.example, couple: { primaryName: "X" } }, "texto"];
    for (const bad of bads) expect((await fetchGuestpassPrefill(PASS, reply(200, bad) as never)).kind).toBe("invalid_response");
  });

  it("nada do casal vai para o log, nem em sucesso nem em falha", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}));
    await fetchGuestpassPrefill(PASS, reply(200, fixture.example) as never);
    await fetchGuestpassPrefill(PASS, reply(200, { ...fixture.example, cpf: "1" }) as never);
    await fetchGuestpassPrefill(PASS, vi.fn(async () => { throw new Error(`falha ${fixture.example.couple.phone}`); }) as never);
    const logged = JSON.stringify(spies.flatMap(spy => spy.mock.calls));
    for (const secret of [fixture.example.couple.primaryName, fixture.example.couple.phone, KEY]) expect(logged).not.toContain(secret);
  });
});

describe("preencher na hora (cliente)", () => {
  const blank = { fullName: "", partnerName: "", phone: "", city: "", state: "SP", lodgingLocation: "", captureLocation: "" };
  const fields = { fullName: "SYN Ana", partnerName: "SYN Bruno", phone: "84900000000", city: "Natal", state: "RN", lodgingLocation: "Hotel SYN", captureLocation: "PONTA-NEGRA", visitDate: null };
  it("preenche campo vazio (e o UF padrão) e NÃO sobrescreve o que a equipe já digitou", () => {
    expect(applyGuestpassFields(blank, fields, blank)).toMatchObject({ fullName: "SYN Ana", state: "RN", phone: "84900000000" });
    expect(applyGuestpassFields({ ...blank, fullName: "Digitado na mão", city: "Parnamirim" }, fields, blank)).toMatchObject({ fullName: "Digitado na mão", city: "Parnamirim", partnerName: "SYN Bruno" });
  });
});
