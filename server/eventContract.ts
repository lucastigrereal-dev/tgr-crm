// WP5 (PRD v4 E0.3 / S17-S18): contrato de eventos que o CRM EMITE, gerado do código real (mesmas funções da entrega).
// Os consumidores (Financial, Relationship, Sales) guardam este JSON como fixture; o teste do CRM falha se o código mudar
// sem regenerar o snapshot (pnpm exec tsx scripts/export-event-contract.ts > shared/contracts/tgr-events.snapshot.json).
// Dados 100% sintéticos.
import { FINANCIAL_EVENT_NAMES, financialBridgeEnvelope } from "./financialBridge";
import { buildContractStateBody, CONTRACT_STATE_TARGETS, type ContractLineage } from "./relationshipBridge";
import { SALES_INGEST_REJECTION_CODES } from "./salesCommandBridge";
import { allowedPayloadFields, integrationContractVersion } from "../shared/integrationContract";

const SYN_PROJECT = { externalKey: "SYN-PONTA-NEGRA", name: "SYN Ponta Negra", timezone: "America/Recife" };
const SYN_LINEAGE: ContractLineage = {
  saleId: "00000000-0000-4000-8000-000000000001", projectExternalKey: SYN_PROJECT.externalKey, projectName: SYN_PROJECT.name,
  projectTimezone: SYN_PROJECT.timezone, correlationId: "SYN-corr-1", customerId: 501, customerName: "SYN Cliente Contrato",
  customerPhone: "84900000000", cancellationReason: "SYN motivo",
};
const AT = new Date("2026-10-05T12:00:00.000Z");

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
    },
    relationship: {
      eventNames: ["crm.contract.activated.v1", "crm.contract.cancelled.v1"],
      sampleBodies: CONTRACT_STATE_TARGETS.relationship.statuses.map(status =>
        buildContractStateBody(SYN_LINEAGE, status, 9001, AT, CONTRACT_STATE_TARGETS.relationship.includeCustomer)),
    },
    sales: {
      cancellationSampleBody: buildContractStateBody(SYN_LINEAGE, "cancelled", 9001, AT, CONTRACT_STATE_TARGETS.salesCancellation.includeCustomer),
      ingestRejection: { status: 422, body: { accepted: false, code: "INSUFFICIENT_INVENTORY", error: "SYN" }, codes: [...SALES_INGEST_REJECTION_CODES] },
    },
  };
}
