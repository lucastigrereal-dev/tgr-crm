// WP5 (PRD v4 E0.3 / S17-S18): contrato de eventos que o CRM EMITE, gerado do código real (mesmas funções da entrega).
// Os consumidores (Financial, Relationship, Sales) guardam este JSON como fixture; o teste do CRM falha se o código mudar
// sem regenerar o snapshot (pnpm exec tsx scripts/export-event-contract.ts > shared/contracts/tgr-events.snapshot.json).
// Dados 100% sintéticos.
import { FINANCIAL_EVENT_NAMES, financialBridgeEnvelope } from "./financialBridge";
import { buildContractStateBody, buildSaleValidatedBody, CONTRACT_STATE_TARGETS, type ContractLineage } from "./relationshipBridge";
import { mapSalesIngestError, SALES_INGEST_REJECTION_CODES, SalesIngestRejection, salesIngestFailureBody } from "./salesCommandBridge";
import { allowedPayloadFields, integrationContractVersion } from "../shared/integrationContract";

const SYN_PROJECT = { externalKey: "SYN-PONTA-NEGRA", name: "SYN Ponta Negra", timezone: "America/Recife" };
const SYN_LINEAGE: ContractLineage = {
  saleId: "00000000-0000-4000-8000-000000000001", projectExternalKey: SYN_PROJECT.externalKey, projectName: SYN_PROJECT.name,
  projectTimezone: SYN_PROJECT.timezone, correlationId: "SYN-corr-1", customerId: 501, customerName: "SYN Cliente Contrato",
  customerPhone: "84900000000", cancellationReason: "SYN motivo",
};
const AT = new Date("2026-10-05T12:00:00.000Z");

function sampleFailure(error: unknown, codes: string[] | undefined) {
  const mapped = mapSalesIngestError(error);
  return { status: mapped.status, body: salesIngestFailureBody(mapped, error), ...(codes ? { codes } : {}) };
}

export function exportEventContract() {
  return {
    contractVersion: integrationContractVersion,
    financial: {
      forwardedEventNames: [...FINANCIAL_EVENT_NAMES],
      allowedPayloadFields: Object.fromEntries(FINANCIAL_EVENT_NAMES.map(name => [name, [...allowedPayloadFields[name]]])),
      sampleEnvelope: financialBridgeEnvelope({
        id: 4242, eventName: "contract.created.v2", aggregateType: "contract", aggregateId: "9001", actorUserId: null, occurredAt: AT,
        payload: JSON.stringify({ contractId: 9001, saleId: SYN_LINEAGE.saleId, customerId: 501, totalAmount: "28900.00", currency: "BRL", status: "active", usageModel: "points", source: "sales-command" }),
      }, SYN_PROJECT),
      saleValidatedSampleEnvelope: financialBridgeEnvelope({
        id: 4243, eventName: "sale.validated", aggregateType: "contract", aggregateId: "9001", actorUserId: 1, occurredAt: AT,
        payload: JSON.stringify({ contractId: 9001, saleId: SYN_LINEAGE.saleId, validatedAt: "2026-10-05T12:00:00.000Z", validatedByUserId: 1, paymentConfirmedAt: "2026-10-04T12:00:00.000Z", signedAt: "2026-10-04T18:00:00.000Z", internalNote: "nunca sai" }),
      }, SYN_PROJECT),
      paymentConfirmedSampleEnvelope: financialBridgeEnvelope({
        id: 4244, eventName: "sale.payment.confirmed", aggregateType: "contract", aggregateId: "9001", actorUserId: 1, occurredAt: AT,
        payload: JSON.stringify({ contractId: 9001, saleId: SYN_LINEAGE.saleId, confirmedAt: "2026-10-04T12:00:00.000Z", confirmedByUserId: 1, note: "nunca sai" }),
      }, SYN_PROJECT),
    },
    relationship: {
      eventNames: ["crm.contract.activated.v1", "crm.contract.cancelled.v1"],
      sampleBodies: CONTRACT_STATE_TARGETS.relationship.statuses.map(status =>
        buildContractStateBody(SYN_LINEAGE, status, 9001, AT, CONTRACT_STATE_TARGETS.relationship.includeCustomer)),
    },
    sales: {
      eventNames: ["crm.contract.cancelled.v1", "crm.sale.validated.v1"],
      saleValidatedSampleBody: buildSaleValidatedBody(SYN_LINEAGE, 9001, AT, { validatedAt: "2026-10-05T12:00:00.000Z", paymentConfirmedAt: "2026-10-04T12:00:00.000Z", signedAt: "2026-10-04T18:00:00.000Z" }),
      cancellationSampleBody: buildContractStateBody(SYN_LINEAGE, "cancelled", 9001, AT, CONTRACT_STATE_TARGETS.salesCancellation.includeCustomer),
      ingestRejection: sampleFailure(new SalesIngestRejection("INSUFFICIENT_INVENTORY", "SYN estoque insuficiente"), [...SALES_INGEST_REJECTION_CODES]),
      ingestTransientFailure: sampleFailure(new Error("SYN falha interna com detalhe que nunca sai"), undefined),
    },
  };
}
