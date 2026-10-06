// ADR-007 (V6): portões puros da venda VALIDADA. Sem banco, sem relógio: quem chama carrega os fatos.
// Contrato `active` (= venda validada) só nasce depois que os quatro pré-requisitos estão abertos E o gerente
// (capacidade `sale.validate`, hoje admin) confirma a validação final.

export const SALE_GATE_KEYS = ["paymentConfirmed", "contractGenerated", "contractSigned", "signedDocumentStored", "noOpenCancellation"] as const;
export type SaleGateKey = (typeof SALE_GATE_KEYS)[number];

export type SaleGateContract = { id: number; signedAt: Date | null };
export type SaleGateDocument = { id: number; signed: boolean; storageKey: string; category: string };

/** contract_documents.category é texto livre; a UI oferece Contrato / Contrato assinado / Aditivo / Comprovante. Só as duas primeiras são o contrato em si. */
const CONTRACT_DOCUMENT_CATEGORIES = new Set(["contrato", "contrato assinado"]);
export const isContractDocumentCategory = (category: string | null | undefined) => typeof category === "string" && CONTRACT_DOCUMENT_CATEGORIES.has(category.trim().toLowerCase());
export type SaleGateEnvelope = { status: string };
export type SaleGateValidation = { paymentConfirmedAt: Date | null; validatedAt: Date | null };

export type SaleValidationGates = {
  paymentConfirmed: boolean;
  contractGenerated: boolean;
  contractSigned: boolean;
  signedDocumentStored: boolean;
  /** Nenhum pedido de distrato aberto (requested|approved). */
  noOpenCancellation: boolean;
  managerValidated: boolean;
  /** Pré-requisitos ainda fechados (não inclui a validação final, que é a própria ação do gerente). */
  missing: SaleGateKey[];
  /** Os quatro pré-requisitos estão abertos: a validação final pode ser feita. */
  ready: boolean;
};

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
  const contractSigned = Boolean(contract) && (Boolean(contract?.signedAt) || documents.some(document => document.signed && isContractDocumentCategory(document.category)));
  const signedDocumentStored = Boolean(contract) && documents.some(document => document.signed && isContractDocumentCategory(document.category) && hasStorageKey(document));
  const noOpenCancellation = (input.openCancellationRequests ?? 0) === 0;
  const managerValidated = Boolean(validation?.validatedAt);
  const flags: Record<SaleGateKey, boolean> = { paymentConfirmed, contractGenerated, contractSigned, signedDocumentStored, noOpenCancellation };
  const missing = SALE_GATE_KEYS.filter(key => !flags[key]);
  return { paymentConfirmed, contractGenerated, contractSigned, signedDocumentStored, noOpenCancellation, managerValidated, missing, ready: missing.length === 0 };
}

/** Documento assinado, da categoria do contrato, com storageKey. Se `preferredId` vier, só ele serve (nunca cai em outro em silêncio). */
export function pickSignedDocument(documents: readonly SaleGateDocument[], preferredId?: number | null): SaleGateDocument | null {
  const usable = documents.filter(document => document.signed && isContractDocumentCategory(document.category) && hasStorageKey(document));
  if (preferredId !== undefined && preferredId !== null) return usable.find(document => document.id === preferredId) ?? null;
  return usable.slice().sort((a, b) => b.id - a.id)[0] ?? null;
}
