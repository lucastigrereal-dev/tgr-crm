import { describe, expect, it } from "vitest";
import { evaluateSaleValidationGates, gatesNotAfter, pickSignedDocument, SALE_GATE_KEYS, saleGateTimestamps } from "./saleValidation";

const T = new Date("2026-10-06T12:00:00.000Z");
const contract = { id: 1, signedAt: null as Date | null };
const doc = (over: Partial<{ id: number; signed: boolean; storageKey: string }> = {}) => ({ id: 10, signed: false, storageKey: "contracts/1/a.pdf", ...over });
const paid = { paymentConfirmedAt: T, validatedAt: null };

describe("evaluateSaleValidationGates (ADR-007)", () => {
  it("contrato sem nada: todos os portões abertos, 4 pendências, não pronto", () => {
    const g = evaluateSaleValidationGates({ contract, documents: [], validation: null });
    expect(g).toMatchObject({ paymentConfirmed: false, contractGenerated: false, contractSigned: false, signedDocumentStored: false, managerValidated: false, ready: false });
    expect(g.missing).toEqual([...SALE_GATE_KEYS]);
  });

  it("contrato inexistente (null) nunca gera portão aberto", () => {
    const g = evaluateSaleValidationGates({ contract: null, documents: [doc({ signed: true })], envelopes: [{ status: "closed" }], validation: { paymentConfirmedAt: T, validatedAt: T } });
    expect(g.contractGenerated).toBe(false);
    expect(g.contractSigned).toBe(false);
    expect(g.signedDocumentStored).toBe(false);
    expect(g.ready).toBe(false);
  });

  it("pagamento confirmado depende só de paymentConfirmedAt", () => {
    expect(evaluateSaleValidationGates({ contract, documents: [], validation: { paymentConfirmedAt: null, validatedAt: null } }).paymentConfirmed).toBe(false);
    expect(evaluateSaleValidationGates({ contract, documents: [], validation: paid }).paymentConfirmed).toBe(true);
  });

  it("contrato gerado: ≥1 documento OU ≥1 envelope; nenhum dos dois = não gerado", () => {
    expect(evaluateSaleValidationGates({ contract, documents: [doc()], validation: null }).contractGenerated).toBe(true);
    expect(evaluateSaleValidationGates({ contract, documents: [], envelopes: [{ status: "draft" }], validation: null }).contractGenerated).toBe(true);
    expect(evaluateSaleValidationGates({ contract, documents: [], envelopes: [], validation: null }).contractGenerated).toBe(false);
  });

  it("contrato assinado: signedAt OU qualquer documento assinado; documento não assinado não conta", () => {
    expect(evaluateSaleValidationGates({ contract: { id: 1, signedAt: T }, documents: [], validation: null }).contractSigned).toBe(true);
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signed: true })], validation: null }).contractSigned).toBe(true);
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signed: false })], validation: null }).contractSigned).toBe(false);
  });

  it("documento assinado armazenado: exige signed E storageKey não vazia", () => {
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signed: true })], validation: null }).signedDocumentStored).toBe(true);
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signed: true, storageKey: "" })], validation: null }).signedDocumentStored).toBe(false);
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signed: true, storageKey: "   " })], validation: null }).signedDocumentStored).toBe(false);
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signed: false })], validation: null }).signedDocumentStored).toBe(false);
  });

  it("signedAt sem documento assinado armazenado: assinado, mas portão de armazenamento fica aberto", () => {
    const g = evaluateSaleValidationGates({ contract: { id: 1, signedAt: T }, documents: [doc()], validation: paid });
    expect(g.contractSigned).toBe(true);
    expect(g.signedDocumentStored).toBe(false);
    expect(g.ready).toBe(false);
    expect(g.missing).toEqual(["signedDocumentStored"]);
  });

  it("webhook (signedAt + documento assinado) sem pagamento confirmado: falta só o pagamento", () => {
    const g = evaluateSaleValidationGates({ contract: { id: 1, signedAt: T }, documents: [doc({ signed: true })], validation: null });
    expect(g.missing).toEqual(["paymentConfirmed"]);
    expect(g.ready).toBe(false);
  });

  it("todos os quatro pré-requisitos: ready=true, mas managerValidated só com validatedAt", () => {
    const base = { contract: { id: 1, signedAt: T }, documents: [doc({ signed: true })] };
    const before = evaluateSaleValidationGates({ ...base, validation: paid });
    expect(before).toMatchObject({ ready: true, managerValidated: false, missing: [] });
    const after = evaluateSaleValidationGates({ ...base, validation: { paymentConfirmedAt: T, validatedAt: T } });
    expect(after).toMatchObject({ ready: true, managerValidated: true, missing: [] });
  });

  it("validatedAt sozinho não substitui os pré-requisitos", () => {
    const g = evaluateSaleValidationGates({ contract, documents: [], validation: { paymentConfirmedAt: null, validatedAt: T } });
    expect(g.managerValidated).toBe(true);
    expect(g.ready).toBe(false);
    expect(g.missing).toEqual([...SALE_GATE_KEYS]);
  });

  it("combinatória exaustiva dos 4 pré-requisitos: missing reflete exatamente os portões falsos", () => {
    for (let mask = 0; mask < 16; mask++) {
      const pay = Boolean(mask & 1), gen = Boolean(mask & 2), signed = Boolean(mask & 4), stored = Boolean(mask & 8);
      const documents = [
        ...(gen || stored || signed ? [doc({ id: 1, signed: false })] : []),
        ...(stored ? [doc({ id: 2, signed: true, storageKey: "k" })] : []),
      ];
      const g = evaluateSaleValidationGates({
        contract: { id: 1, signedAt: signed ? T : null },
        documents,
        validation: pay ? paid : null,
      });
      const expected = [!pay && "paymentConfirmed", !(gen || stored || signed) && "contractGenerated", !(signed || stored) && "contractSigned", !stored && "signedDocumentStored"].filter(Boolean);
      expect(g.missing, `mask ${mask}`).toEqual(expected);
      expect(g.ready).toBe(expected.length === 0);
    }
  });
});

describe("pickSignedDocument", () => {
  it("escolhe o assinado com storageKey, mais recente; respeita preferido válido", () => {
    const docs = [doc({ id: 1, signed: true, storageKey: "a" }), doc({ id: 3, signed: true, storageKey: "c" }), doc({ id: 2, signed: false, storageKey: "b" })];
    expect(pickSignedDocument(docs)?.id).toBe(3);
    expect(pickSignedDocument(docs, 1)?.id).toBe(1);
  });
  it("preferido não assinado/inexistente ou sem storageKey => null (não cai em outro silenciosamente)", () => {
    const docs = [doc({ id: 1, signed: true, storageKey: "a" }), doc({ id: 2, signed: false, storageKey: "b" }), doc({ id: 4, signed: true, storageKey: " " })];
    expect(pickSignedDocument(docs, 2)).toBeNull();
    expect(pickSignedDocument(docs, 99)).toBeNull();
    expect(pickSignedDocument(docs, 4)).toBeNull();
  });
  it("sem documento assinado armazenado => null", () => {
    expect(pickSignedDocument([doc({ signed: false })])).toBeNull();
    expect(pickSignedDocument([])).toBeNull();
  });
});

describe("saleGateTimestamps (KAN-31 V6)", () => {
  const at = (iso: string) => new Date(iso);
  it("contrato gerado = primeiro documento ou envelope; assinado e armazenado vêm dos fatos", () => {
    const stamps = saleGateTimestamps({
      documents: [{ createdAt: at("2026-10-05T10:00:00Z") }, { createdAt: at("2026-10-05T18:05:00Z") }],
      envelopes: [{ createdAt: at("2026-10-04T09:00:00Z") }],
      contractSignedAt: at("2026-10-05T18:00:00Z"),
      storedDocument: { createdAt: at("2026-10-05T18:05:00Z") },
    });
    expect(stamps).toEqual({ contractGeneratedAt: at("2026-10-04T09:00:00Z"), contractSignedAt: at("2026-10-05T18:00:00Z"), documentStoredAt: at("2026-10-05T18:05:00Z") });
  });
  it("sem envelope usa o documento mais antigo", () => {
    const stamps = saleGateTimestamps({ documents: [{ createdAt: at("2026-10-05T10:00:00Z") }], envelopes: [], contractSignedAt: at("2026-10-05T11:00:00Z"), storedDocument: { createdAt: at("2026-10-05T10:00:00Z") } });
    expect(stamps.contractGeneratedAt).toEqual(at("2026-10-05T10:00:00Z"));
  });
  it("gatesNotAfter: nenhum portão pode ser posterior à validação (o Sales recusaria com 422)", () => {
    const stamps = { contractGeneratedAt: at("2026-10-05T10:00:00Z"), contractSignedAt: at("2026-10-07T00:00:00Z"), documentStoredAt: at("2026-10-05T10:00:00Z") };
    expect(gatesNotAfter({ ...stamps, paymentConfirmedAt: at("2026-10-05T10:00:00Z") }, at("2026-10-06T12:00:00Z"))).toBe(false);
    expect(gatesNotAfter({ ...stamps, contractSignedAt: at("2026-10-05T11:00:00Z"), paymentConfirmedAt: at("2026-10-05T10:00:00Z") }, at("2026-10-06T12:00:00Z"))).toBe(true);
  });
});
