// ADR-007 (V6): portões puros da venda VALIDADA. Sem banco, sem relógio: quem chama carrega os fatos.
// Contrato `active` (= venda validada) só nasce depois que os quatro pré-requisitos estão abertos E o gerente
// (capacidade `sale.validate`, hoje admin) confirma a validação final.

export const SALE_GATE_KEYS = ["paymentConfirmed", "contractGenerated", "contractSigned", "signedDocumentStored", "noOpenCancellation", "noOpenSignatureEnvelope"] as const;
export type SaleGateKey = (typeof SALE_GATE_KEYS)[number];

export type SaleGateContract = { id: number; signedAt: Date | null };
/**
 * `signed` (rascunho marcado como assinado: webhook de e-sign, markDocumentSigned) é só exibição e NUNCA entra nos portões.
 * `signedArtifact` = arquivo assinado de verdade guardado no storage (upload de admin com `document.sign`); só ele vale.
 * `createdAt` do artefato = horário atestado do armazenamento (fallback de `signedAt`).
 */
export type SaleGateDocument = { id: number; signedArtifact: boolean; storageKey: string; category: string; createdAt?: Date };

/** contract_documents.category é texto livre; a UI oferece Contrato / Contrato assinado / Aditivo / Comprovante. Só as duas primeiras são o contrato em si. */
const CONTRACT_DOCUMENT_CATEGORIES = new Set(["contrato", "contrato assinado"]);
/** Caixa, acentos, `_`/`-` e espaços repetidos não diferenciam ("contrato_assinado" = "Contrato Assinado"). */
export const normalizeDocumentCategory = (category: string) => category.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
export const isContractDocumentCategory = (category: string | null | undefined) => typeof category === "string" && CONTRACT_DOCUMENT_CATEGORIES.has(normalizeDocumentCategory(category));
const OPEN_ENVELOPE_STATUSES = new Set(["draft", "running"]);
export type SaleGateEnvelope = { status: string };
export type SaleGateValidation = { paymentConfirmedAt: Date | null; validatedAt: Date | null };

export type SaleValidationGates = {
  paymentConfirmed: boolean;
  contractGenerated: boolean;
  contractSigned: boolean;
  signedDocumentStored: boolean;
  /** Nenhum pedido de distrato aberto (requested|approved). */
  noOpenCancellation: boolean;
  /** Nenhum envelope de e-assinatura em andamento (draft|running): o contrato ainda pode mudar/ser assinado. */
  noOpenSignatureEnvelope: boolean;
  managerValidated: boolean;
  /** Pré-requisitos ainda fechados (não inclui a validação final, que é a própria ação do gerente). */
  missing: SaleGateKey[];
  /** Os quatro pré-requisitos estão abertos: a validação final pode ser feita. */
  ready: boolean;
};

const isSignedArtifactOfContract = (document: SaleGateDocument) => document.signedArtifact === true && isContractDocumentCategory(document.category);
const hasStorageKey = (document: SaleGateDocument) => typeof document.storageKey === "string" && document.storageKey.trim().length > 0;

export function evaluateSaleValidationGates(input: {
  contract: SaleGateContract | null | undefined;
  documents: readonly SaleGateDocument[];
  envelopes?: readonly SaleGateEnvelope[];
  validation: SaleGateValidation | null | undefined;
  /** Pedidos de distrato em requested|approved. */
  openCancellationRequests?: number;
}): SaleValidationGates {
  const { contract, documents, validation } = input;
  const envelopes = input.envelopes ?? [];
  const paymentConfirmed = Boolean(validation?.paymentConfirmedAt);
  const contractGenerated = Boolean(contract) && (documents.length > 0 || envelopes.length > 0);
  const contractSigned = Boolean(contract) && (Boolean(contract?.signedAt) || documents.some(isSignedArtifactOfContract));
  const signedDocumentStored = Boolean(contract) && documents.some(document => isSignedArtifactOfContract(document) && hasStorageKey(document));
  const noOpenSignatureEnvelope = !envelopes.some(envelope => OPEN_ENVELOPE_STATUSES.has(envelope.status));
  const noOpenCancellation = (input.openCancellationRequests ?? 0) === 0;
  const managerValidated = Boolean(validation?.validatedAt);
  const flags: Record<SaleGateKey, boolean> = { paymentConfirmed, contractGenerated, contractSigned, signedDocumentStored, noOpenCancellation, noOpenSignatureEnvelope };
  const missing = SALE_GATE_KEYS.filter(key => !flags[key]);
  return { paymentConfirmed, contractGenerated, contractSigned, signedDocumentStored, noOpenCancellation, noOpenSignatureEnvelope, managerValidated, missing, ready: missing.length === 0 };
}

/** Arquivo assinado (signedArtifact), da categoria do contrato, com storageKey. Se `preferredId` vier, só ele serve (nunca cai em outro em silêncio). */
export function pickSignedDocument(documents: readonly SaleGateDocument[], preferredId?: number | null): SaleGateDocument | null {
  const usable = documents.filter(document => isSignedArtifactOfContract(document) && hasStorageKey(document));
  if (preferredId !== undefined && preferredId !== null) return usable.find(document => document.id === preferredId) ?? null;
  return usable.slice().sort((a, b) => b.id - a.id)[0] ?? null;
}

/**
 * KAN-31 V6: referência OPACA do documento assinado armazenado, a única que sai do CRM (Sales `gates.documentRef`).
 * Só ids internos: nunca storageKey, nome de arquivo, URL, token ou dado do cliente. O PDF nunca vai para o Git.
 */
export function saleDocumentRef(contractId: number, documentId: number) {
  return `crm-doc:${contractId}:${documentId}`;
}

export type SaleGateTimestamps = { contractGeneratedAt: Date; contractSignedAt: Date; documentStoredAt: Date };

/**
 * KAN-31 V6: instantes dos portões congelados na validação final. "Contrato gerado" = primeiro documento ou envelope
 * do contrato; "assinado" = signedAt resolvido pelo chamador; "armazenado" = criação do documento assinado escolhido.
 */
export function saleGateTimestamps(input: {
  documents: readonly { createdAt: Date }[];
  envelopes: readonly { createdAt: Date }[];
  contractSignedAt: Date;
  storedDocument: { createdAt: Date };
}): SaleGateTimestamps {
  const generated = [...input.documents, ...input.envelopes].map(item => item.createdAt.getTime());
  return {
    contractGeneratedAt: new Date(Math.min(...generated, input.storedDocument.createdAt.getTime())),
    contractSignedAt: input.contractSignedAt,
    documentStoredAt: input.storedDocument.createdAt,
  };
}

/** Nenhum portão pode ser posterior à validação final (o receptor do Sales recusaria com 422). */
export function gatesNotAfter(gates: SaleGateTimestamps & { paymentConfirmedAt: Date }, validatedAt: Date) {
  return [gates.paymentConfirmedAt, gates.contractGeneratedAt, gates.contractSignedAt, gates.documentStoredAt].every(stamp => stamp.getTime() <= validatedAt.getTime());
}
