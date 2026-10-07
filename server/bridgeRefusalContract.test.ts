import { afterEach, describe, expect, it, vi } from "vitest";

// KAN-31 V6 / PIL-008 (R7): recusa de CONTEÚDO = 4xx (exceto 408/425/429) + `code` [A-Z0-9_] => DLQ na 1ª tentativa,
// com o motivo. Condição transitória nunca carrega code => tenta de novo. No Financial, 409 SEM code é ordem de
// chegada (ex.: comissão paga antes do sale.validated) e nunca vai para a DLQ.
vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: vi.fn() }));

import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";
import { startFinancialBridgePump } from "./financialBridge";
import { createRejectionTracker, DeliveryRejectedError, readRejectionCode, startSalesCancellationBridgePump } from "./relationshipBridge";

// Backoff por evento: cada tick de teste avança o relógio além do teto (10 min), então todo evento em retry está vencido.
const pumpClock = { t: 0 };
function eagerPump<P extends { tick(): Promise<number>; stop(): void }>(start: (...args: any[]) => P, ...args: any[]): P {
  const last = args.length - 1;
  const pump = start(...args.slice(0, last), { ...args[last], now: () => pumpClock.t });
  return { ...pump, tick: async () => { pumpClock.t += 11 * 60_000; return pump.tick(); } };
}

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
  for (const method of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) promise[method] = () => promise;
  return promise;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("readRejectionCode", () => {
  it("lê o code só de 4xx com code [A-Z0-9_]; 5xx, minúsculo e corpo não-JSON => null", async () => {
    expect(await readRejectionCode(json(422, { error: "x", code: "SALE_VALIDATION_GATES_INCOMPLETE" }))).toBe("SALE_VALIDATION_GATES_INCOMPLETE");
    expect(await readRejectionCode(json(409, { error: "x", code: "SALE_ALREADY_CANCELLED" }))).toBe("SALE_ALREADY_CANCELLED");
    expect(await readRejectionCode(json(404, { error: "not found" }))).toBeNull();
    expect(await readRejectionCode(json(503, { error: "x", code: "IGNORED" }))).toBeNull();
    expect(await readRejectionCode(json(422, { code: "lower-case" }))).toBeNull();
    expect(await readRejectionCode(new Response("<html>", { status: 422 }))).toBeNull();
  });
});

describe("createRejectionTracker", () => {
  it("recusa com code (alvo PIL-008) => desiste já na 1ª", () => {
    const tracker = createRejectionTracker<string>(60_000, Date.now, { codedRejections: true });
    expect(tracker.record("k", new DeliveryRejectedError("Sales", 422, "SALE_VALIDATION_GATES_INCOMPLETE"))).toBe(true);
  });
  it("KAN-31 V6: 409 sem code com conflictIsTransient nunca desiste; 409 COM code continua terminal; sem a opção mantém a tolerância de 5", () => {
    const transient = createRejectionTracker<string>(0, Date.now, { codedRejections: true, conflictIsTransient: true });
    for (let n = 0; n < 20; n += 1) expect(transient.record("k", new DeliveryRejectedError("Financial", 409))).toBe(false);
    expect(transient.record("k", new DeliveryRejectedError("Financial", 409, "SALE_VALIDATION_SALE_MISMATCH"))).toBe(true);
    const legacy = createRejectionTracker<string>(0);
    const results = Array.from({ length: 5 }, () => legacy.record("k", new DeliveryRejectedError("Sales", 409)));
    expect(results).toEqual([false, false, false, false, true]);
  });
});

describe("Sales: crm.sale.validated.v1 reage às respostas do receptor", () => {
  afterEach(() => vi.resetAllMocks());
  const saleId = "44444444-4444-4444-8444-444444444444";
  const payload = {
    contractId: 303, saleId, validatedAt: "2026-10-06T12:00:00.000Z", validatedBy: "7", paymentConfirmedAt: "2026-10-05T12:00:00.000Z", paymentConfirmedBy: "7",
    contractGeneratedAt: "2026-10-04T12:00:00.000Z", contractSignedAt: "2026-10-05T18:00:00.000Z", documentStoredAt: "2026-10-05T18:05:00.000Z", documentRef: "crm-doc:303:55",
  };
  function oneValidatedEvent() {
    const event = { id: 12, eventName: "sale.validated", aggregateType: "contract", aggregateId: "303", actorUserId: 7, payload: JSON.stringify(payload), idempotencyKey: null, occurredAt: new Date("2026-10-06T12:00:01.000Z") };
    const sequence: unknown[] = [
      [event], [],
      [{ customerId: 101, customerName: "SYN", customerPhone: null, proposalId: 404, opportunityId: 202, cancellationReason: null }],
      [{ payload: JSON.stringify({ saleId, projectExternalKey: "22222222-2222-4222-8222-222222222222", projectName: "SYN", projectTimezone: "America/Recife", correlationId: "corr-1" }) }],
    ];
    let i = 0;
    vi.mocked(getDb).mockResolvedValue({ select: vi.fn(() => chain(sequence[i++ % sequence.length])) } as never);
    vi.mocked(recordAudit).mockResolvedValue(undefined);
  }
  const pump = () => eagerPump(startSalesCancellationBridgePump, "http://127.0.0.1:3100", "k", { autoStart: false, onError: vi.fn() });

  for (const [status, code] of [[422, "SALE_VALIDATION_GATES_INCOMPLETE"], [409, "SALE_NOT_PAYMENT_CONFIRMED"], [409, "SALE_ALREADY_CANCELLED"], [409, "SALE_VALIDATION_IDENTITY_CONFLICT"]] as const) {
    it(`${status} ${code}: DLQ na 1ª tentativa, com o motivo`, async () => {
      oneValidatedEvent();
      vi.mocked(fetchWithTimeout).mockImplementation(async () => json(status, { error: "recusado", code }));
      const p = pump();
      try { await p.tick(); } finally { p.stop(); }
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_sale_validated_rejected",
        `crm.sale.validated.v1 recusado pelo TGR Sales Command (HTTP ${status}, code ${code}).`, { idempotencyKey: "sales-contract:303:validated" });
    });
  }

  for (const status of [404, 503]) {
    it(`${status} sem code: tenta de novo e nunca grava recibo`, async () => {
      oneValidatedEvent();
      vi.mocked(fetchWithTimeout).mockImplementation(async () => json(status, { error: "transitório" }));
      const p = eagerPump(startSalesCancellationBridgePump, "http://127.0.0.1:3100", "k", { autoStart: false, onError: vi.fn(), rejectionWindowMs: 0 });
      try { for (let n = 0; n < 8; n += 1) await p.tick(); } finally { p.stop(); }
      expect(fetchWithTimeout).toHaveBeenCalledTimes(8);
      expect(recordAudit).not.toHaveBeenCalled();
    });
  }

  it("200 {replay:true}: idempotente, vira recibo de entregue", async () => {
    oneValidatedEvent();
    vi.mocked(fetchWithTimeout).mockImplementation(async () => json(200, { accepted: true, replay: true }));
    const p = pump();
    try { expect(await p.tick()).toBe(1); } finally { p.stop(); }
    expect(recordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_sale_validated_delivered", "crm.sale.validated.v1 entregue ao TGR Sales Command.", { idempotencyKey: "sales-contract:303:validated" });
  });
});

describe("Financial: sale.validated e comissão reagem às respostas do receptor", () => {
  afterEach(() => vi.resetAllMocks());
  const project = { externalKey: "22222222-2222-4222-8222-222222222222", name: "SYN", timezone: "America/Recife" };
  function oneEvent(eventName: string, payload: Record<string, unknown>, extraSelects: unknown[] = []) {
    const event = { id: 601, eventName, aggregateType: "contract", aggregateId: "303", actorUserId: 7, payload: JSON.stringify(payload), idempotencyKey: null, occurredAt: new Date("2026-10-06T12:00:01.000Z") };
    const sequence: unknown[] = [[{ event }], [], ...extraSelects];
    let i = 0;
    vi.mocked(getDb).mockResolvedValue({ select: vi.fn(() => chain(sequence[i++ % sequence.length])) } as never);
    vi.mocked(recordAudit).mockResolvedValue(undefined);
  }
  const validated = { contractId: 303, saleId: "S-1", validatedAt: "2026-10-06T12:00:00.000Z", validatedBy: "7" };

  it("409 SALE_VALIDATION_SALE_MISMATCH: DLQ na 1ª, com o motivo", async () => {
    oneEvent("sale.validated", validated);
    vi.mocked(fetchWithTimeout).mockImplementation(async () => json(409, { error: "Sale does not match the contract", code: "SALE_VALIDATION_SALE_MISMATCH" }));
    const p = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError: vi.fn() });
    try { await p.tick(); } finally { p.stop(); }
    expect(recordAudit).toHaveBeenCalledWith(null, "integration_event", 601, "financial_rejected",
      "sale.validated recusado pelo TGR Financial Layer (HTTP 409, code SALE_VALIDATION_SALE_MISMATCH).", { idempotencyKey: "financial-event:601" });
  });

  it("comissão paga antes da validação: 409 SEM code é ordem de chegada, tenta sempre e nunca vai para a DLQ", async () => {
    oneEvent("commission.status.updated", { status: "paid", contractId: 303 }, [[{ customerId: 101 }]]);
    vi.mocked(fetchWithTimeout).mockImplementation(async () => json(409, { error: "Commission settlement waiting for sale validation" }));
    const p = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError: vi.fn(), rejectionWindowMs: 0 });
    try { for (let n = 0; n < 12; n += 1) await p.tick(); } finally { p.stop(); }
    expect(fetchWithTimeout).toHaveBeenCalledTimes(12);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("comissão sem contrato: 422 COMMISSION_BEFORE_SALE_VALIDATION vai para a DLQ na 1ª", async () => {
    oneEvent("commission.status.updated", { status: "paid", contractId: null });
    vi.mocked(fetchWithTimeout).mockImplementation(async () => json(422, { error: "x", code: "COMMISSION_BEFORE_SALE_VALIDATION" }));
    const p = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError: vi.fn() });
    try { await p.tick(); } finally { p.stop(); }
    expect(recordAudit).toHaveBeenCalledWith(null, "integration_event", 601, "financial_rejected",
      "commission.status.updated recusado pelo TGR Financial Layer (HTTP 422, code COMMISSION_BEFORE_SALE_VALIDATION).", { idempotencyKey: "financial-event:601" });
  });

  it("429 com code é transitório (nunca DLQ)", async () => {
    oneEvent("sale.validated", validated);
    vi.mocked(fetchWithTimeout).mockImplementation(async () => json(429, { code: "RATE_LIMITED" }));
    const p = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError: vi.fn(), rejectionWindowMs: 0 });
    try { for (let n = 0; n < 8; n += 1) await p.tick(); } finally { p.stop(); }
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("sale.validated sem saleId (contrato fora do Sales Command): vai ao Financial com saleId null, sem inventar", async () => {
    oneEvent("sale.validated", { ...validated, saleId: null });
    vi.mocked(fetchWithTimeout).mockImplementation(async () => json(200, { accepted: true }));
    const p = eagerPump(startFinancialBridgePump, "http://127.0.0.1:3400", "k", project, { autoStart: false, onError: vi.fn() });
    try { await p.tick(); } finally { p.stop(); }
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(vi.mocked(fetchWithTimeout).mock.calls[0]![1]!.body));
    expect(sent.event.eventName).toBe("sale.validated");
    expect(sent.event.payload.saleId).toBeNull();
    expect(recordAudit).not.toHaveBeenCalledWith(null, "integration_event", 601, "financial_not_applicable", expect.anything(), expect.anything());
  });
});
