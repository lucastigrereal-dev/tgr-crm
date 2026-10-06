import { afterEach, describe, expect, it, vi } from "vitest";

// ADR-007 (V6): crm.sale.validated.v1 -> Sales Command (mesmo endpoint/chave do distrato), só linhagem sales-command, sem PII.
vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn() }));
vi.mock("./integrationReliability", () => ({ fetchWithTimeout: vi.fn() }));

import { getDb, recordAudit } from "./db";
import { fetchWithTimeout } from "./integrationReliability";
import { buildSaleValidatedBody, saleValidatedFactsFrom, startRelationshipBridgePump, startSalesCancellationBridgePump, type ContractLineage } from "./relationshipBridge";

const mockedGetDb = vi.mocked(getDb);
const mockedRecordAudit = vi.mocked(recordAudit);
const mockedFetch = vi.mocked(fetchWithTimeout);

function chain<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
  for (const method of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) promise[method] = () => promise;
  return promise;
}

const lineage: ContractLineage = {
  saleId: "44444444-4444-4444-4444-444444444444", projectExternalKey: "22222222-2222-2222-2222-222222222222", projectName: "SYN Resort",
  projectTimezone: "America/Recife", correlationId: "corr-sale-1", customerId: 101, customerName: "Ana & Bruno", customerPhone: "84999990000", cancellationReason: null,
};
// KAN-31 V6: fatos completos (instantes + atores opacos + documentRef opaco), no formato que o Sales aceita.
const facts = {
  validatedAt: "2026-10-06T12:00:00.000Z", validatedBy: "7", paymentConfirmedAt: "2026-10-05T12:00:00.000Z", paymentConfirmedBy: "7",
  contractGeneratedAt: "2026-10-04T12:00:00.000Z", contractSignedAt: "2026-10-05T18:00:00.000Z", documentStoredAt: "2026-10-05T18:05:00.000Z", documentRef: "crm-doc:303:55",
};
const at = new Date("2026-10-06T12:00:01.000Z");

describe("buildSaleValidatedBody", () => {
  it("monta exatamente o contrato crm.sale.validated.v1", () => {
    expect(buildSaleValidatedBody(lineage, 303, at, facts)).toEqual({
      eventId: "crm-sale-303-validated",
      eventName: "crm.sale.validated.v1",
      source: "crm",
      correlationId: "corr-sale-1",
      occurredAt: "2026-10-06T12:00:01.000Z",
      project: { externalKey: lineage.projectExternalKey, name: "SYN Resort", timezone: "America/Recife" },
      saleId: lineage.saleId,
      contractId: "303",
      validatedAt: facts.validatedAt,
      validatedBy: "7",
      gates: {
        paymentConfirmedAt: facts.paymentConfirmedAt, paymentConfirmedBy: "7", contractGeneratedAt: facts.contractGeneratedAt,
        contractSignedAt: facts.contractSignedAt, documentStoredAt: facts.documentStoredAt, documentRef: "crm-doc:303:55",
      },
    });
  });

  it("não carrega PII do cliente nem caminho/arquivo do documento (só a referência opaca)", () => {
    const body = buildSaleValidatedBody(lineage, 303, at, facts);
    const text = JSON.stringify(body);
    for (const forbidden of ["customer", "Ana", "84999990000", "storageKey", "phone", ".pdf", "contracts/"]) expect(text).not.toContain(forbidden);
  });

  it("sem correlationId na linhagem usa crm-sale-<id>-validated", () => {
    expect(buildSaleValidatedBody({ ...lineage, correlationId: null }, 303, at, facts).correlationId).toBe("crm-sale-303-validated");
  });

  it("saleValidatedFactsFrom exige todos os portões válidos", () => {
    expect(saleValidatedFactsFrom({ ...facts, contractId: 303 })).toEqual(facts);
    expect(saleValidatedFactsFrom({ ...facts, contractSignedAt: undefined })).toBeNull();
    expect(saleValidatedFactsFrom({ ...facts, paymentConfirmedAt: "ontem" })).toBeNull();
    expect(saleValidatedFactsFrom({ ...facts, documentRef: "contracts/303/assinado.pdf" })).toBeNull();
    expect(saleValidatedFactsFrom({})).toBeNull();
  });
});

describe("pump: seleção de eventos sale.validated", () => {
  afterEach(() => vi.resetAllMocks());

  const validatedEvent = (id: number, payload: Record<string, unknown> = { contractId: 303, saleId: lineage.saleId, ...facts }) => ({ id, eventName: "sale.validated", aggregateType: "contract", aggregateId: "303", actorUserId: 1, payload: JSON.stringify(payload), idempotencyKey: null, occurredAt: at });
  const activatedEvent = { id: 11, eventName: "contract.status.updated", aggregateType: "contract", aggregateId: "303", actorUserId: 1, payload: JSON.stringify({ status: "active" }), idempotencyKey: null, occurredAt: at };
  const lineageRows = (hasLineage = true) => [
    [{ customerId: 101, customerName: "Ana & Bruno", customerPhone: "84999990000", proposalId: 404, opportunityId: hasLineage ? 202 : null, cancellationReason: null }],
    [{ payload: JSON.stringify({ saleId: lineage.saleId, projectExternalKey: lineage.projectExternalKey, projectName: "SYN Resort", projectTimezone: "America/Recife", correlationId: "corr-sale-1" }) }],
  ];
  function dbWith(sequence: unknown[]) {
    let i = 0;
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => chain(sequence[i++ % sequence.length] ?? [])) } as never);
  }

  it("entrega crm.sale.validated.v1 ao Sales no endpoint de eventos do CRM, com chave e recibo próprios; ignora a ativação", async () => {
    // select 1: eventos; para cada evento relevante: recibo, linhagem(2). A ativação não é entregue ao Sales.
    dbWith([[activatedEvent, validatedEvent(12)], [], ...lineageRows()]);
    mockedFetch.mockResolvedValue(new Response("{}", { status: 201 }));
    mockedRecordAudit.mockResolvedValue(undefined);
    const pump = startSalesCancellationBridgePump("http://127.0.0.1:3100", "sales-key", { autoStart: false });
    try { expect(await pump.tick()).toBe(1); } finally { pump.stop(); }
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [target, init] = mockedFetch.mock.calls[0]!;
    expect(String(target)).toBe("http://127.0.0.1:3100/api/integration/crm/events");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer sales-key");
    expect(headers.get("X-Correlation-Id")).toBe("corr-sale-1");
    expect(JSON.parse(String(init?.body))).toEqual(buildSaleValidatedBody(lineage, 303, at, facts));
    expect(mockedRecordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_sale_validated_delivered", "crm.sale.validated.v1 entregue ao TGR Sales Command.", { idempotencyKey: "sales-contract:303:validated" });
  });

  it("o pump do Relationship NÃO recebe sale.validated (só ativação/cancelamento)", async () => {
    dbWith([[validatedEvent(12)], [], ...lineageRows()]);
    mockedRecordAudit.mockResolvedValue(undefined);
    const pump = startRelationshipBridgePump("http://127.0.0.1:3200", "rel-key", { autoStart: false });
    try { expect(await pump.tick()).toBe(0); } finally { pump.stop(); }
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedRecordAudit).not.toHaveBeenCalled();
  });

  it("contrato sem linhagem sales-command: recibo not_applicable, nada enviado", async () => {
    dbWith([[validatedEvent(12)], [], ...lineageRows(false)]);
    mockedRecordAudit.mockResolvedValue(undefined);
    const pump = startSalesCancellationBridgePump("http://127.0.0.1:3100", "sales-key", { autoStart: false });
    try { expect(await pump.tick()).toBe(0); } finally { pump.stop(); }
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedRecordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_sale_validated_not_applicable", expect.stringContaining("sem linhagem"), { idempotencyKey: "sales-contract:303:validated" });
  });

  it("evento já entregue (recibo existe) não é reenviado", async () => {
    dbWith([[validatedEvent(12)], [{ id: 5 }]]);
    const pump = startSalesCancellationBridgePump("http://127.0.0.1:3100", "sales-key", { autoStart: false });
    try { expect(await pump.tick()).toBe(0); } finally { pump.stop(); }
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("payload sem os portões: recibo de recusa visível (DLQ), não trava a fila nem inventa data", async () => {
    dbWith([[validatedEvent(12, { contractId: 303, validatedAt: facts.validatedAt })], [], ...lineageRows()]);
    mockedRecordAudit.mockResolvedValue(undefined);
    const pump = startSalesCancellationBridgePump("http://127.0.0.1:3100", "sales-key", { autoStart: false });
    try { await pump.tick(); } finally { pump.stop(); }
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedRecordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_sale_validated_rejected", expect.stringContaining("sale.validated sem os portões"), { idempotencyKey: "sales-contract:303:validated" });
  });

  it("recusa de conteúdo repetida (409 x5) vira recibo terminal próprio; 503 nunca descarta", async () => {
    const sequence = [[validatedEvent(12)], [], ...lineageRows()];
    let i = 0;
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => chain(sequence[i++ % sequence.length])) } as never);
    mockedFetch.mockImplementation(async () => new Response("{}", { status: 409 }));
    mockedRecordAudit.mockResolvedValue(undefined);
    const pump = startSalesCancellationBridgePump("http://127.0.0.1:3100", "k", { autoStart: false, rejectionWindowMs: 0, onError: vi.fn() });
    try { for (let n = 0; n < 5; n += 1) await pump.tick(); } finally { pump.stop(); }
    expect(mockedRecordAudit).toHaveBeenCalledWith(null, "contract", 303, "sales_sale_validated_rejected", "crm.sale.validated.v1 recusado pelo TGR Sales Command 5x seguidas (HTTP 409).", { idempotencyKey: "sales-contract:303:validated" });

    vi.resetAllMocks();
    i = 0;
    mockedGetDb.mockResolvedValue({ select: vi.fn(() => chain(sequence[i++ % sequence.length])) } as never);
    mockedFetch.mockImplementation(async () => new Response("{}", { status: 503 }));
    const transient = startSalesCancellationBridgePump("http://127.0.0.1:3100", "k", { autoStart: false, rejectionWindowMs: 0, onError: vi.fn() });
    try { for (let n = 0; n < 8; n += 1) await transient.tick(); } finally { transient.stop(); }
    expect(mockedRecordAudit).not.toHaveBeenCalled();
  });
});
