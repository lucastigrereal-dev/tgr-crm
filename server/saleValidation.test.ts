import { describe, expect, it } from "vitest";
import { evaluateSaleValidationGates, pickSignedDocument, SALE_GATE_KEYS } from "./saleValidation";

const T = new Date("2026-10-06T12:00:00.000Z");
const contract = { id: 1, signedAt: null as Date | null };
const doc = (over: Partial<{ id: number; signedArtifact: boolean; storageKey: string; category: string }> = {}) => ({ id: 10, signedArtifact: false, signed: false, storageKey: "contracts/1/a.pdf", category: "Contrato", ...over });
const paid = { paymentConfirmedAt: T, validatedAt: null };

describe("evaluateSaleValidationGates (ADR-007)", () => {
  it("contrato sem nada: todos os portões abertos, 4 pendências, não pronto", () => {
    const g = evaluateSaleValidationGates({ contract, documents: [], validation: null });
    expect(g).toMatchObject({ paymentConfirmed: false, contractGenerated: false, contractSigned: false, signedDocumentStored: false, managerValidated: false, ready: false });
    expect(g.missing).toEqual(SALE_GATE_KEYS.filter(key => key !== "noOpenCancellation" && key !== "noOpenSignatureEnvelope"));
  });

  it("contrato inexistente (null) nunca gera portão aberto", () => {
    const g = evaluateSaleValidationGates({ contract: null, documents: [doc({ signedArtifact: true })], envelopes: [{ status: "closed" }], validation: { paymentConfirmedAt: T, validatedAt: T } });
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
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true })], validation: null }).contractSigned).toBe(true);
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: false })], validation: null }).contractSigned).toBe(false);
  });

  it("documento assinado armazenado: exige signed E storageKey não vazia", () => {
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true })], validation: null }).signedDocumentStored).toBe(true);
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true, storageKey: "" })], validation: null }).signedDocumentStored).toBe(false);
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true, storageKey: "   " })], validation: null }).signedDocumentStored).toBe(false);
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: false })], validation: null }).signedDocumentStored).toBe(false);
  });

  it("signedAt sem documento assinado armazenado: assinado, mas portão de armazenamento fica aberto", () => {
    const g = evaluateSaleValidationGates({ contract: { id: 1, signedAt: T }, documents: [doc()], validation: paid });
    expect(g.contractSigned).toBe(true);
    expect(g.signedDocumentStored).toBe(false);
    expect(g.ready).toBe(false);
    expect(g.missing).toEqual(["signedDocumentStored"]);
  });

  it("webhook (signedAt + documento assinado) sem pagamento confirmado: falta só o pagamento", () => {
    const g = evaluateSaleValidationGates({ contract: { id: 1, signedAt: T }, documents: [doc({ signedArtifact: true })], validation: null });
    expect(g.missing).toEqual(["paymentConfirmed"]);
    expect(g.ready).toBe(false);
  });

  it("todos os quatro pré-requisitos: ready=true, mas managerValidated só com validatedAt", () => {
    const base = { contract: { id: 1, signedAt: T }, documents: [doc({ signedArtifact: true })] };
    const before = evaluateSaleValidationGates({ ...base, validation: paid });
    expect(before).toMatchObject({ ready: true, managerValidated: false, missing: [] });
    const after = evaluateSaleValidationGates({ ...base, validation: { paymentConfirmedAt: T, validatedAt: T } });
    expect(after).toMatchObject({ ready: true, managerValidated: true, missing: [] });
  });

  it("validatedAt sozinho não substitui os pré-requisitos", () => {
    const g = evaluateSaleValidationGates({ contract, documents: [], validation: { paymentConfirmedAt: null, validatedAt: T } });
    expect(g.managerValidated).toBe(true);
    expect(g.ready).toBe(false);
    expect(g.missing).toEqual(SALE_GATE_KEYS.filter(key => key !== "noOpenCancellation" && key !== "noOpenSignatureEnvelope"));
  });

  it("combinatória exaustiva dos 4 pré-requisitos: missing reflete exatamente os portões falsos", () => {
    for (let mask = 0; mask < 16; mask++) {
      const pay = Boolean(mask & 1), gen = Boolean(mask & 2), signed = Boolean(mask & 4), stored = Boolean(mask & 8);
      const documents = [
        ...(gen || stored || signed ? [doc({ id: 1, signedArtifact: false })] : []),
        ...(stored ? [doc({ id: 2, signedArtifact: true, storageKey: "k" })] : []),
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

describe("portões: só documento da categoria do contrato conta (revisão KAN-31)", () => {
  it("cópia de RG/comprovante assinada NÃO satisfaz contractSigned nem signedDocumentStored", () => {
    for (const category of ["Comprovante", "Documento pessoal", "Aditivo", "RG"]) {
      const g = evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true, category })], validation: paid });
      expect(g.contractSigned, category).toBe(false);
      expect(g.signedDocumentStored, category).toBe(false);
      expect(g.ready, category).toBe(false);
    }
  });
  it("categorias do contrato (Contrato / Contrato assinado, sem diferenciar caixa) satisfazem", () => {
    for (const category of ["Contrato", "Contrato assinado", " contrato ", "CONTRATO ASSINADO", "contrato"]) {
      const g = evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true, category })], validation: paid });
      expect(g.signedDocumentStored, category).toBe(true);
      expect(g.ready, category).toBe(true);
    }
  });
  it("signedAt continua valendo como contrato assinado, mas o documento armazenado exige a categoria do contrato", () => {
    const g = evaluateSaleValidationGates({ contract: { id: 1, signedAt: T }, documents: [doc({ signedArtifact: true, category: "Comprovante" })], validation: paid });
    expect(g.contractSigned).toBe(true);
    expect(g.signedDocumentStored).toBe(false);
  });
});

describe("portão noOpenCancellation (revisão KAN-31)", () => {
  const base = { contract: { id: 1, signedAt: T }, documents: [doc({ signedArtifact: true })], validation: paid };
  it("sem pedido de distrato aberto: portão aberto e pronto", () => {
    expect(evaluateSaleValidationGates({ ...base, openCancellationRequests: 0 })).toMatchObject({ noOpenCancellation: true, ready: true, missing: [] });
    expect(evaluateSaleValidationGates(base)).toMatchObject({ noOpenCancellation: true, ready: true });
  });
  it("pedido requested|approved aberto: fecha o portão e entra em missing", () => {
    const g = evaluateSaleValidationGates({ ...base, openCancellationRequests: 1 });
    expect(g).toMatchObject({ noOpenCancellation: false, ready: false, missing: ["noOpenCancellation"] });
  });
});

describe("pickSignedDocument", () => {
  it("escolhe o assinado com storageKey, mais recente; respeita preferido válido", () => {
    const docs = [doc({ id: 1, signedArtifact: true, storageKey: "a" }), doc({ id: 3, signedArtifact: true, storageKey: "c" }), doc({ id: 2, signedArtifact: false, storageKey: "b" })];
    expect(pickSignedDocument(docs)?.id).toBe(3);
    expect(pickSignedDocument(docs, 1)?.id).toBe(1);
  });
  it("preferido não assinado/inexistente ou sem storageKey => null (não cai em outro silenciosamente)", () => {
    const docs = [doc({ id: 1, signedArtifact: true, storageKey: "a" }), doc({ id: 2, signedArtifact: false, storageKey: "b" }), doc({ id: 4, signedArtifact: true, storageKey: " " })];
    expect(pickSignedDocument(docs, 2)).toBeNull();
    expect(pickSignedDocument(docs, 99)).toBeNull();
    expect(pickSignedDocument(docs, 4)).toBeNull();
  });
  it("sem documento assinado armazenado => null", () => {
    expect(pickSignedDocument([doc({ signedArtifact: false })])).toBeNull();
    expect(pickSignedDocument([])).toBeNull();
  });
});

describe("pickSignedDocument: categoria do contrato (revisão KAN-31)", () => {
  it("documento assinado de outra categoria nunca é escolhido, nem como preferido", () => {
    const docs = [doc({ id: 1, signedArtifact: true, storageKey: "a", category: "Contrato assinado" }), doc({ id: 9, signedArtifact: true, storageKey: "z", category: "Comprovante" })];
    expect(pickSignedDocument(docs)?.id).toBe(1);
    expect(pickSignedDocument(docs, 9)).toBeNull();
    expect(pickSignedDocument([doc({ id: 9, signedArtifact: true, category: "RG" })])).toBeNull();
  });
});

describe("RED TEAM: contrato assinado exige arquivo assinado real (signedArtifact)", () => {
  it("rascunho marcado signed (e-sign/markDocumentSigned) NÃO abre contractSigned nem signedDocumentStored", () => {
    const g = evaluateSaleValidationGates({ contract, documents: [doc({ signed: true, signedArtifact: false })], validation: paid });
    expect(g.contractSigned).toBe(false);
    expect(g.signedDocumentStored).toBe(false);
    expect(pickSignedDocument([doc({ signed: true, signedArtifact: false })])).toBeNull();
  });
  it("signedArtifact de categoria do contrato abre os dois portões; de outra categoria não", () => {
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true })], validation: paid })).toMatchObject({ contractSigned: true, signedDocumentStored: true, ready: true });
    expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true, category: "Aditivo" })], validation: paid }).contractSigned).toBe(false);
  });
  it("normaliza caixa, acentos, underscore e hífen na categoria", () => {
    for (const category of ["contrato_assinado", "Contrato Assinado", "contrato-assinado", "CONTRATO_ASSINADO", "Contráto  assinado", "Contrato"]) {
      expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true, category })], validation: paid }).signedDocumentStored, category).toBe(true);
    }
    for (const category of ["contrato_assinado_rg", "Aditivo de contrato", "", "assinado"]) {
      expect(evaluateSaleValidationGates({ contract, documents: [doc({ signedArtifact: true, category })], validation: paid }).signedDocumentStored, category).toBe(false);
    }
  });
});

describe("RED TEAM: portão noOpenSignatureEnvelope", () => {
  const base = { contract: { id: 1, signedAt: T }, documents: [doc({ signedArtifact: true })], validation: paid };
  it("envelope draft/running bloqueia", () => {
    for (const status of ["draft", "running"]) {
      const g = evaluateSaleValidationGates({ ...base, envelopes: [{ status }] });
      expect(g, status).toMatchObject({ noOpenSignatureEnvelope: false, ready: false, missing: ["noOpenSignatureEnvelope"] });
    }
  });
  it("envelope closed/canceled/error ou ausente não bloqueia", () => {
    for (const status of ["closed", "canceled", "error"]) expect(evaluateSaleValidationGates({ ...base, envelopes: [{ status }] }), status).toMatchObject({ noOpenSignatureEnvelope: true, ready: true });
    expect(evaluateSaleValidationGates(base)).toMatchObject({ noOpenSignatureEnvelope: true, ready: true });
  });
});
