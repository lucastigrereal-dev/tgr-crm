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
  it("o conteúdo (sem _source) é o do GuestPass #47 / Suite #191 (hash c0405c3c…): mudou = o GuestPass muda primeiro, depois a Suite, depois aqui", () => {
    const { _source, ...content } = fixture;
    expect(_source).toContain("tgr-guestpass");
    expect(createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex")).toBe("c0405c3c58f520236596cb36bc616c2006e1ea05dad8553f583285b594db376c");
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
    if (result.kind === "ok") expect(prefillToFormFields(result.prefill)).toEqual({ fullName: "EXEMPLO Titular", partnerName: "EXEMPLO Acompanhante", phone: "8400000000", city: "Cidade Exemplo", state: "UF", lodgingLocation: "Hospedagem Exemplo", captureLocation: "PONTA-NEGRA", visitDate: "2026-10-02", visitMode: "agendamento", visitTime: "18:30", partnerPhone: "8400000001", holderAge: "34" });
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

  it("ficha v2: visitType, visitTime HH:MM, phone2 e titularAge inteiro são validados em runtime; qualquer desvio descarta a resposta inteira", async () => {
    const withCouple = (couple: Record<string, unknown>) => ({ ...fixture.example, couple: { ...fixture.example.couple, ...couple } });
    const bads = [
      { ...fixture.example, visitType: "PASSANTE" }, { ...fixture.example, visitType: "agendamento" },
      ...["25:00", "9:30", "18:60", "18h30", "18:30:00", "", "noite"].map(visitTime => ({ ...fixture.example, visitTime })),
      { ...fixture.example, visitType: "TOUR_DIRETO", visitTime: "18:30" }, // tour direto não tem horário
      { ...fixture.example, visitDate: null, visitTime: "18:30" }, // horário sem data
      withCouple({ titularAge: "34" }), withCouple({ titularAge: 34.5 }), withCouple({ titularAge: -1 }), withCouple({ titularAge: 121 }), withCouple({ phone2: "" }), withCouple({ phone2: 123 }),
    ];
    for (const bad of bads) expect((await fetchGuestpassPrefill(PASS, reply(200, bad) as never)).kind, JSON.stringify(bad).slice(0, 120)).toBe("invalid_response");
  });
  it("ficha v2: tour direto sem horário, agendamento sem horário e ficha antiga (sem os campos novos) são aceitos", async () => {
    const tour = { ...fixture.example, visitType: "TOUR_DIRETO", visitTime: undefined, visitDate: "2026-10-26" };
    const noTime = { ...fixture.example, visitTime: undefined };
    const { visitType: _t, visitTime: _h, ...legacyTop } = fixture.example;
    const { phone2: _p, titularAge: _a, ...legacyCouple } = fixture.example.couple;
    for (const body of [tour, noTime, { ...legacyTop, couple: legacyCouple }]) expect((await fetchGuestpassPrefill(PASS, reply(200, body) as never)).kind).toBe("ok");
    const result = await fetchGuestpassPrefill(PASS, reply(200, { ...legacyTop, couple: legacyCouple }) as never);
    if (result.kind === "ok") expect(prefillToFormFields(result.prefill)).toMatchObject({ visitMode: "", visitTime: "", partnerPhone: "", holderAge: "" });
    const tourResult = await fetchGuestpassPrefill(PASS, reply(200, tour) as never);
    if (tourResult.kind === "ok") expect(prefillToFormFields(tourResult.prefill)).toMatchObject({ visitMode: "tour_direto", visitTime: "", visitDate: "2026-10-26" });
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

describe("preencher na hora: ficha v2 (cliente)", () => {
  const blank = { fullName: "", partnerName: "", phone: "", city: "", state: "SP", lodgingLocation: "", captureLocation: "", scheduledAt: "", visitMode: "", partnerPhone: "", holderAge: "" };
  const base = { fullName: "SYN Ana", partnerName: "SYN Bruno", phone: "84900000000", city: "Natal", state: "RN", lodgingLocation: "", captureLocation: "", visitDate: "2026-11-02" };
  it("com a flag desligada os campos novos não entram", () => {
    const filled = applyGuestpassFields(blank, { ...base, visitMode: "agendamento", visitTime: "18:30", partnerPhone: "84911112222", holderAge: "41" }, blank);
    expect(filled).toMatchObject({ visitMode: "", partnerPhone: "", holderAge: "", scheduledAt: "" });
  });
  it("com a flag ligada: agendamento preenche tipo, 2º telefone, idade e data+hora (se vazias), sem sobrescrever o digitado", () => {
    const fields = { ...base, visitMode: "agendamento", visitTime: "18:30", partnerPhone: "84911112222", holderAge: "41" };
    expect(applyGuestpassFields(blank, fields, blank, true)).toMatchObject({ visitMode: "agendamento", partnerPhone: "84911112222", holderAge: "41", scheduledAt: "2026-11-02T18:30" });
    expect(applyGuestpassFields({ ...blank, holderAge: "50", scheduledAt: "2026-12-01T10:00" }, fields, blank, true)).toMatchObject({ holderAge: "50", scheduledAt: "2026-12-01T10:00" });
  });
  it("com a flag ligada: tour direto não tem horário e limpa a data e hora", () => {
    const filled = applyGuestpassFields({ ...blank, scheduledAt: "2026-12-01T10:00" }, { ...base, visitMode: "tour_direto", visitTime: "" }, blank, true);
    expect(filled).toMatchObject({ visitMode: "tour_direto", scheduledAt: "" });
  });
  it("modo já escolhido pela equipe vence o do passe: agendamento digitado não é apagado por passe de tour direto; tour retido não recebe data do passe", () => {
    const typed = applyGuestpassFields({ ...blank, visitMode: "agendamento", scheduledAt: "2026-12-01T10:00" }, { ...base, visitMode: "tour_direto", visitTime: "" }, blank, true);
    expect(typed).toMatchObject({ visitMode: "agendamento", scheduledAt: "2026-12-01T10:00" });
    const tourKept = applyGuestpassFields({ ...blank, visitMode: "tour_direto" }, { ...base, visitMode: "agendamento", visitTime: "18:30" }, blank, true);
    expect(tourKept).toMatchObject({ visitMode: "tour_direto", scheduledAt: "" });
  });
  it("tour direto (retido ou do passe) desliga o passante", () => {
    const withPasserby = { ...blank, isPasserby: true };
    expect(applyGuestpassFields(withPasserby, { ...base, visitMode: "tour_direto", visitTime: "" }, withPasserby, true)).toMatchObject({ visitMode: "tour_direto", isPasserby: false });
    expect(applyGuestpassFields({ ...withPasserby, visitMode: "tour_direto" }, { ...base, visitMode: "agendamento", visitTime: "18:30" }, withPasserby, true)).toMatchObject({ isPasserby: false });
  });
  it("sem horário no agendamento, data e hora ficam para a equipe", () => {
    expect(applyGuestpassFields(blank, { ...base, visitMode: "agendamento", visitTime: "" }, blank, true)).toMatchObject({ scheduledAt: "" });
  });
});
